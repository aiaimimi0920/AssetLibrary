use std::path::{Path, PathBuf};

use tough::{
    ExpirationEnforcement, IntoVec, Limits, Prefix, Repository, RepositoryLoader, TargetName,
};

use crate::{
    ControlPolicy, InstalledRelease, RepositoryConfig, TrustedCandidate, UpdateError,
    policy::{select_candidate, validate_control},
};

const MAX_CONTROL_BYTES: u64 = 64 * 1024;

pub struct AppUpdateRepository {
    repository: Repository,
    config: RepositoryConfig,
}

impl AppUpdateRepository {
    pub async fn load(config: RepositoryConfig) -> Result<Self, UpdateError> {
        prepare_datastore(&config.datastore).await?;
        let repository = RepositoryLoader::new(
            &config.bootstrap_root,
            config.metadata_base_url.clone(),
            config.targets_base_url.clone(),
        )
        .datastore(config.datastore.clone())
        .expiration_enforcement(ExpirationEnforcement::Safe)
        .limits(Limits {
            max_root_size: 256 * 1024,
            max_targets_size: 4 * 1024 * 1024,
            max_timestamp_size: 256 * 1024,
            max_snapshot_size: 256 * 1024,
            max_root_updates: 32,
        })
        .load()
        .await?;
        validate_root_policy(&repository)?;
        Ok(Self { repository, config })
    }

    pub fn trusted_root_version(&self) -> u64 {
        self.repository.root().signed.version.get()
    }

    pub async fn control(&self, previous_epoch: u64) -> Result<ControlPolicy, UpdateError> {
        let path = format!("control.{}.json", self.config.identity.platform);
        let name = TargetName::new(path).map_err(UpdateError::Repository)?;
        let target = self
            .repository
            .targets()
            .signed
            .targets
            .get(&name)
            .ok_or(UpdateError::TargetNotFound)?;
        if target.length == 0 || target.length > MAX_CONTROL_BYTES {
            return Err(UpdateError::Policy(
                "control target exceeds the client bound",
            ));
        }
        let stream = self
            .repository
            .read_target(&name)
            .await?
            .ok_or(UpdateError::TargetNotFound)?;
        let bytes = stream.into_vec().await?;
        let control = ControlPolicy::from_slice(&bytes)?;
        validate_control(&control, self.config.identity, previous_epoch)?;
        Ok(control)
    }

    pub fn candidate(
        &self,
        target_path: &str,
        installed: &InstalledRelease,
        control: &ControlPolicy,
    ) -> Result<TrustedCandidate, UpdateError> {
        let name = TargetName::new(target_path.to_owned()).map_err(UpdateError::Repository)?;
        let target = self
            .repository
            .targets()
            .signed
            .targets
            .get(&name)
            .ok_or(UpdateError::TargetNotFound)?;
        select_candidate(self.config.identity, installed, control, &name, target)
    }

    pub async fn download(
        &self,
        candidate: &TrustedCandidate,
        staging_root: &Path,
    ) -> Result<PathBuf, UpdateError> {
        prepare_staging_root(staging_root).await?;
        let name =
            TargetName::new(candidate.target_path.clone()).map_err(UpdateError::Repository)?;
        let target = self
            .repository
            .targets()
            .signed
            .targets
            .get(&name)
            .ok_or(UpdateError::TargetNotFound)?;
        if target.length != candidate.length
            || hex::encode(&*target.hashes.sha256) != candidate.sha256
        {
            return Err(UpdateError::Policy(
                "candidate no longer matches trusted metadata",
            ));
        }
        let destination = staging_root.join(name.resolved());
        if tokio::fs::try_exists(&destination).await? {
            return Err(UpdateError::Policy("staging destination already exists"));
        }
        self.repository
            .save_target(&name, staging_root, Prefix::None)
            .await?;
        Ok(destination)
    }
}

async fn prepare_datastore(path: &Path) -> Result<(), UpdateError> {
    tokio::fs::create_dir_all(path).await?;
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(UpdateError::Configuration(
            "datastore must be a real directory",
        ));
    }
    Ok(())
}

async fn prepare_staging_root(path: &Path) -> Result<(), UpdateError> {
    let metadata = tokio::fs::symlink_metadata(path).await?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err(UpdateError::Configuration(
            "staging root must be a real directory",
        ));
    }
    Ok(())
}

fn validate_root_policy(repository: &Repository) -> Result<(), UpdateError> {
    use std::collections::HashSet;
    use tough::schema::{
        RoleType,
        key::{EcdsaScheme, Ed25519Scheme, Key},
    };

    let root = &repository.root().signed;
    if !root.consistent_snapshot || root.spec_version != "1.0.0" {
        return Err(UpdateError::Policy(
            "root must use TUF 1.0 consistent snapshots",
        ));
    }
    let now = jiff::Timestamp::now();
    let expiries = [
        (root.expires, 8_760_i64),
        (repository.targets().signed.expires, 2_160),
        (repository.snapshot().signed.expires, 168),
        (repository.timestamp().signed.expires, 24),
    ];
    for (expires, maximum_hours) in expiries {
        if expires <= now || expires > now + jiff::SignedDuration::from_hours(maximum_hours) {
            return Err(UpdateError::Policy(
                "metadata expiry exceeds its role ceiling",
            ));
        }
    }
    let expected = [
        (RoleType::Root, 2_u64, 3_usize),
        (RoleType::Targets, 2, 3),
        (RoleType::Snapshot, 1, 1),
        (RoleType::Timestamp, 1, 1),
    ];
    let mut role_keys = HashSet::new();
    for (role, threshold, key_count) in expected {
        let keys = root
            .roles
            .get(&role)
            .ok_or(UpdateError::Policy("root is missing a required role"))?;
        if keys.threshold.get() != threshold || keys.keyids.len() != key_count {
            return Err(UpdateError::Policy("root role threshold violates policy"));
        }
        for key_id in &keys.keyids {
            let key = root
                .keys
                .get(key_id)
                .ok_or(UpdateError::Policy("root role references an unknown key"))?;
            let approved_algorithm = match role {
                RoleType::Root | RoleType::Targets => matches!(
                    key,
                    Key::Ed25519 {
                        scheme: Ed25519Scheme::Ed25519,
                        ..
                    }
                ),
                RoleType::Snapshot | RoleType::Timestamp => matches!(
                    key,
                    Key::Ecdsa {
                        scheme: EcdsaScheme::EcdsaSha2Nistp256,
                        ..
                    }
                ),
                RoleType::DelegatedTargets => false,
            };
            if !approved_algorithm || !role_keys.insert(hex::encode(&**key_id)) {
                return Err(UpdateError::Policy(
                    "root roles must use distinct keys with approved algorithms",
                ));
            }
        }
    }
    let has_delegations = repository
        .targets()
        .signed
        .delegations
        .as_ref()
        .is_some_and(|delegations| !delegations.keys.is_empty() || !delegations.roles.is_empty());
    if root.keys.len() != role_keys.len() || has_delegations {
        return Err(UpdateError::Policy(
            "root keys or delegated targets violate repository isolation",
        ));
    }
    Ok(())
}
