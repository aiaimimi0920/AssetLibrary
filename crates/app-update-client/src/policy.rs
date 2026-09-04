use std::collections::HashSet;

use tough::{TargetName, schema::Target};

use crate::{
    Channel, ControlPolicy, InstalledRelease, RepositoryIdentity, TrustedCandidate, UpdateError,
    UpdateUrgency, model::TargetDescriptor,
};

const CUSTOM_KEY: &str = "neuro_app_update";
const SCHEMA_VERSION: &str = "1.0";
const UPDATER_PROTOCOL: u32 = 1;
const MAX_ARTIFACT_BYTES: u64 = 2_147_483_648;
const MAX_REVOKED_DIGESTS: usize = 512;

pub(crate) fn validate_control(
    control: &ControlPolicy,
    identity: RepositoryIdentity,
    previous_epoch: u64,
) -> Result<(), UpdateError> {
    if control.schema_version != SCHEMA_VERSION
        || control.product != identity.product
        || control.channel != identity.channel
        || control.platform != identity.platform
    {
        return Err(UpdateError::Policy(
            "control identity does not match the repository",
        ));
    }
    if control.policy_epoch == 0 || control.policy_epoch < previous_epoch {
        return Err(UpdateError::Policy("control policy epoch rolled back"));
    }
    if control.minimum_release_sequence == 0 {
        return Err(UpdateError::Policy(
            "minimum release sequence must be positive",
        ));
    }
    if control.revoked_sha256.len() > MAX_REVOKED_DIGESTS {
        return Err(UpdateError::Policy(
            "revocation list exceeds the client bound",
        ));
    }
    let mut unique = HashSet::with_capacity(control.revoked_sha256.len());
    for digest in &control.revoked_sha256 {
        if !is_sha256(digest) || !unique.insert(digest) {
            return Err(UpdateError::Policy(
                "revocation digest is invalid or duplicated",
            ));
        }
    }
    if !control.installation_enabled
        && control
            .reason
            .as_deref()
            .is_none_or(|reason| reason.trim().is_empty() || reason.chars().count() > 500)
    {
        return Err(UpdateError::Policy(
            "a disabled channel requires a bounded reason",
        ));
    }
    Ok(())
}

pub(crate) fn select_candidate(
    identity: RepositoryIdentity,
    installed: &InstalledRelease,
    control: &ControlPolicy,
    target_name: &TargetName,
    target: &Target,
) -> Result<TrustedCandidate, UpdateError> {
    validate_control(control, identity, installed.policy_epoch)?;
    if installed.sequence == 0 || installed.policy_epoch == 0 || !is_sha256(&installed.sha256) {
        return Err(UpdateError::Policy("installed release state is invalid"));
    }
    if !control.installation_enabled {
        return Err(UpdateError::Policy(
            "the signed channel kill switch is active",
        ));
    }
    if target.custom.len() != 1 {
        return Err(UpdateError::Policy(
            "target custom metadata is not canonical",
        ));
    }
    let descriptor = target
        .custom
        .get(CUSTOM_KEY)
        .ok_or(UpdateError::Policy("target custom metadata is missing"))?;
    let descriptor: TargetDescriptor = serde_json::from_value(descriptor.clone())?;
    validate_descriptor(&descriptor, identity)?;
    validate_target_path(target_name, identity, descriptor.release_sequence)?;
    if descriptor.release_sequence <= installed.sequence {
        return Err(UpdateError::Policy(
            "remote application downgrade is forbidden",
        ));
    }
    if descriptor.release_sequence < control.minimum_release_sequence {
        return Err(UpdateError::Policy(
            "candidate is below the signed release floor",
        ));
    }
    if target.length == 0 || target.length > MAX_ARTIFACT_BYTES {
        return Err(UpdateError::Policy(
            "candidate length is outside the client bound",
        ));
    }
    let sha256 = hex::encode(&*target.hashes.sha256);
    if control.revoked_sha256.iter().any(|value| value == &sha256) {
        return Err(UpdateError::Policy("candidate digest is revoked"));
    }
    let version = semver::Version::parse(&descriptor.version)
        .map_err(|_| UpdateError::Policy("candidate version is not SemVer"))?;
    if identity.channel == Channel::Stable && !version.pre.is_empty() {
        return Err(UpdateError::Policy(
            "stable channel cannot select a prerelease",
        ));
    }
    let current_revoked = control
        .revoked_sha256
        .iter()
        .any(|value| value == &installed.sha256);
    let urgency = if installed.sequence < control.minimum_release_sequence || current_revoked {
        UpdateUrgency::Required
    } else {
        UpdateUrgency::Optional
    };
    Ok(TrustedCandidate {
        target_path: target_name.raw().to_owned(),
        version,
        release_sequence: descriptor.release_sequence,
        length: target.length,
        sha256,
        urgency,
    })
}

pub fn rollback_allowed(control: &ControlPolicy, previous: &InstalledRelease) -> bool {
    previous.sequence >= control.minimum_release_sequence
        && is_sha256(&previous.sha256)
        && !control
            .revoked_sha256
            .iter()
            .any(|digest| digest == &previous.sha256)
}

fn validate_descriptor(
    descriptor: &TargetDescriptor,
    identity: RepositoryIdentity,
) -> Result<(), UpdateError> {
    if descriptor.schema_version != SCHEMA_VERSION
        || descriptor.product != identity.product
        || descriptor.channel != identity.channel
        || descriptor.platform != identity.platform
    {
        return Err(UpdateError::Policy(
            "candidate identity does not match the repository",
        ));
    }
    if descriptor.release_sequence == 0 || descriptor.updater_protocol != UPDATER_PROTOCOL {
        return Err(UpdateError::Policy(
            "candidate protocol or sequence is unsupported",
        ));
    }
    Ok(())
}

fn validate_target_path(
    name: &TargetName,
    identity: RepositoryIdentity,
    sequence: u64,
) -> Result<(), UpdateError> {
    if name.raw() != name.resolved() || name.raw().contains(['\\', '%']) {
        return Err(UpdateError::Policy(
            "candidate target path is not canonical",
        ));
    }
    let parts = name.raw().splitn(4, '.').collect::<Vec<_>>();
    let valid_filename = parts.get(3).is_some_and(|filename| {
        !filename.is_empty()
            && filename.len() <= 128
            && filename
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || b"._-".contains(&value))
    });
    if parts.len() != 4
        || parts[0] != "release"
        || parts[1] != identity.platform.to_string()
        || parts[2] != sequence.to_string()
        || !valid_filename
    {
        return Err(UpdateError::Policy(
            "candidate target path violates the repository layout",
        ));
    }
    Ok(())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|character| character.is_ascii_digit() || (b'a'..=b'f').contains(&character))
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tough::schema::Target;

    use super::*;
    use crate::{Channel, Platform, Product};

    fn identity() -> RepositoryIdentity {
        RepositoryIdentity {
            product: Product::Loom,
            channel: Channel::Stable,
            platform: Platform::WindowsX86_64,
        }
    }

    fn installed() -> InstalledRelease {
        InstalledRelease {
            sequence: 40,
            sha256: "a".repeat(64),
            policy_epoch: 7,
        }
    }

    fn control() -> ControlPolicy {
        ControlPolicy::from_slice(
            &serde_json::to_vec(&json!({
                "schema_version": "1.0", "product": "loom", "channel": "stable",
                "platform": "windows-x86_64", "policy_epoch": 8,
                "installation_enabled": true, "minimum_release_sequence": 39,
                "revoked_sha256": [], "reason": null
            }))
            .unwrap(),
        )
        .unwrap()
    }

    fn target() -> Target {
        serde_json::from_value(json!({
            "length": 1024,
            "hashes": {"sha256": "b".repeat(64)},
            "custom": {"neuro_app_update": {
                "schema_version": "1.0", "product": "loom", "channel": "stable",
                "platform": "windows-x86_64", "version": "1.4.0",
                "release_sequence": 41, "updater_protocol": 1
            }}
        }))
        .unwrap()
    }

    #[test]
    fn accepts_identity_bound_monotonic_candidate() {
        let candidate = select_candidate(
            identity(),
            &installed(),
            &control(),
            &TargetName::new("release.windows-x86_64.41.loom.zip").unwrap(),
            &target(),
        )
        .unwrap();
        assert_eq!(candidate.release_sequence(), 41);
        assert_eq!(candidate.urgency(), UpdateUrgency::Optional);
    }

    #[test]
    fn rejects_downgrade_path_and_extra_custom_metadata() {
        let mut target = target();
        assert!(
            select_candidate(
                identity(),
                &installed(),
                &control(),
                &TargetName::new("release.windows-x86_64.39.loom.zip").unwrap(),
                &target,
            )
            .is_err()
        );
        target.custom.insert("other".into(), json!(true));
        assert!(
            select_candidate(
                identity(),
                &installed(),
                &control(),
                &TargetName::new("release.windows-x86_64.41.loom.zip").unwrap(),
                &target,
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_control_rollback_duplicate_revocation_and_kill_switch() {
        let mut policy = control();
        policy.policy_epoch = 6;
        assert!(validate_control(&policy, identity(), 7).is_err());
        policy = control();
        policy.revoked_sha256 = vec!["c".repeat(64), "c".repeat(64)];
        assert!(validate_control(&policy, identity(), 7).is_err());
        policy = control();
        policy.installation_enabled = false;
        policy.reason = Some("incident containment".into());
        assert!(
            select_candidate(
                identity(),
                &installed(),
                &policy,
                &TargetName::new("release.windows-x86_64.41.loom.zip").unwrap(),
                &target(),
            )
            .is_err()
        );
    }

    #[test]
    fn rejects_wrong_identity_invalid_length_and_revoked_candidate() {
        let mut wrong_identity = target();
        wrong_identity.custom.insert(
            "neuro_app_update".into(),
            json!({
                "schema_version": "1.0", "product": "hook", "channel": "stable",
                "platform": "windows-x86_64", "version": "1.4.0",
                "release_sequence": 41, "updater_protocol": 1
            }),
        );
        let name = TargetName::new("release.windows-x86_64.41.loom.zip").unwrap();
        assert!(
            select_candidate(identity(), &installed(), &control(), &name, &wrong_identity).is_err()
        );

        let mut invalid_length = target();
        invalid_length.length = 0;
        assert!(
            select_candidate(identity(), &installed(), &control(), &name, &invalid_length).is_err()
        );

        let mut revoked = control();
        revoked.revoked_sha256.push("b".repeat(64));
        assert!(select_candidate(identity(), &installed(), &revoked, &name, &target()).is_err());
    }

    #[test]
    fn rollback_rejects_revoked_or_below_floor_release() {
        let mut policy = control();
        let previous = installed();
        assert!(rollback_allowed(&policy, &previous));
        policy.revoked_sha256.push(previous.sha256.clone());
        assert!(!rollback_allowed(&policy, &previous));
        policy.revoked_sha256.clear();
        policy.minimum_release_sequence = 41;
        assert!(!rollback_allowed(&policy, &previous));
    }
}
