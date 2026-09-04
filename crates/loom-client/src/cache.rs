use assetlibrary_contracts::{InstallChallenge, SCHEMA_VERSION_V1};
use serde::{Deserialize, Serialize};
use std::{
    fs::File,
    path::{Path, PathBuf},
};
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

use crate::ClientError;

pub(crate) struct CachePaths {
    pub partial: PathBuf,
    pub state: PathBuf,
    pub verified: PathBuf,
}

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct PartialState {
    schema_version: String,
    artifact_id: Uuid,
    release_id: Uuid,
    canonical_sha256: String,
    archive_sha256: String,
    size_bytes: u64,
}

impl CachePaths {
    pub async fn prepare(root: &Path, challenge: &InstallChallenge) -> Result<Self, ClientError> {
        reject_symlink(root).await?;
        let partial_dir = root.join("partial");
        let verified_dir = root.join("verified");
        fs::create_dir_all(&partial_dir).await?;
        fs::create_dir_all(&verified_dir).await?;
        harden_directory(root).await?;
        harden_directory(&partial_dir).await?;
        harden_directory(&verified_dir).await?;
        reject_symlink(&partial_dir).await?;
        reject_symlink(&verified_dir).await?;
        let digest = &challenge.artifact.digest;
        let paths = Self {
            partial: partial_dir.join(format!("{digest}.part")),
            state: partial_dir.join(format!("{digest}.json")),
            verified: verified_dir.join(format!("{digest}.zip")),
        };
        for path in [&paths.partial, &paths.state, &paths.verified] {
            reject_symlink(path).await?;
        }
        Ok(paths)
    }

    pub async fn ensure_state(&self, challenge: &InstallChallenge) -> Result<(), ClientError> {
        ensure_state(&self.state, expected_state(challenge)).await
    }
}

pub(crate) async fn file_size(path: &Path) -> Result<u64, ClientError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => Err(
            ClientError::Configuration("cache file is not a regular file"),
        ),
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn open_partial_append(path: &Path) -> Result<fs::File, ClientError> {
    let path = path.to_owned();
    let file = tokio::task::spawn_blocking(move || open_regular_append(&path))
        .await
        .map_err(|_| ClientError::VerificationTask)??;
    Ok(fs::File::from_std(file))
}

pub(crate) async fn link_verified(source: &Path, destination: &Path) -> Result<(), ClientError> {
    match fs::hard_link(source, destination).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(()),
        Err(error) => Err(error.into()),
    }
}

pub(crate) async fn finalize_verified(
    source: &Path,
    destination: &Path,
) -> Result<(), ClientError> {
    let mut permissions = fs::metadata(destination).await?.permissions();
    permissions.set_readonly(true);
    fs::set_permissions(destination, permissions).await?;
    if fs::try_exists(source).await? {
        fs::remove_file(source).await?;
    }
    Ok(())
}

fn expected_state(challenge: &InstallChallenge) -> PartialState {
    PartialState {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        artifact_id: challenge.artifact.artifact_id,
        release_id: challenge.artifact.release_id,
        canonical_sha256: challenge.artifact.digest.clone(),
        archive_sha256: challenge.archive_sha256.clone(),
        size_bytes: challenge.artifact.size_bytes,
    }
}

async fn ensure_state(path: &Path, expected: PartialState) -> Result<(), ClientError> {
    if fs::try_exists(path).await? {
        return read_state(path, &expected).await;
    }
    let temporary = path.with_extension(format!("json.{}.tmp", Uuid::new_v4()));
    let bytes = serde_json::to_vec(&expected).map_err(|_| ClientError::InvalidResponse)?;
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;
    file.write_all(&bytes).await?;
    file.sync_all().await?;
    let link_result = match fs::hard_link(&temporary, path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            read_state(path, &expected).await
        }
        Err(error) => Err(error.into()),
    };
    let cleanup_result = fs::remove_file(&temporary).await;
    link_result?;
    cleanup_result?;
    Ok(())
}

async fn read_state(path: &Path, expected: &PartialState) -> Result<(), ClientError> {
    let bytes = fs::read(path).await?;
    let actual =
        serde_json::from_slice::<PartialState>(&bytes).map_err(|_| ClientError::InvalidResponse)?;
    if &actual != expected {
        return Err(ClientError::InvalidResponse);
    }
    Ok(())
}

async fn reject_symlink(path: &Path) -> Result<(), ClientError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ClientError::Configuration("cache directory is a symlink"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn open_regular_append(path: &Path) -> Result<File, ClientError> {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    configure_no_follow(&mut options);
    let file = options.open(path)?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata_is_reparse_point(&metadata) {
        return Err(ClientError::Configuration(
            "cache file is not a regular file",
        ));
    }
    Ok(file)
}

#[cfg(unix)]
fn configure_no_follow(options: &mut std::fs::OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW).mode(0o600);
}

#[cfg(windows)]
fn configure_no_follow(options: &mut std::fs::OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn configure_no_follow(_options: &mut std::fs::OpenOptions) {}

#[cfg(windows)]
fn metadata_is_reparse_point(metadata: &std::fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0000_0400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_reparse_point(_metadata: &std::fs::Metadata) -> bool {
    false
}

#[cfg(unix)]
async fn harden_directory(path: &Path) -> Result<(), ClientError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn harden_directory(_path: &Path) -> Result<(), ClientError> {
    Ok(())
}

#[cfg(all(test, unix))]
mod tests {
    use super::open_partial_append;
    use std::os::unix::fs::symlink;

    #[tokio::test]
    async fn partial_open_never_follows_a_symlink() {
        let root = tempfile::TempDir::new().unwrap();
        let victim = root.path().join("victim");
        let partial = root.path().join("partial");
        std::fs::write(&victim, b"preserve").unwrap();
        symlink(&victim, &partial).unwrap();

        assert!(open_partial_append(&partial).await.is_err());
        assert_eq!(std::fs::read(victim).unwrap(), b"preserve");
    }
}
