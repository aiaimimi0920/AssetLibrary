use assetlibrary_contracts::{
    ArtifactDigest, ArtifactStatus, CompleteUploadSessionRequest, CreateUploadSessionRequest,
    DigestAlgorithm, MAX_ARTIFACT_SIZE, MAX_PARTS, MIN_PART_SIZE, ResumableUploadSession,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use time::OffsetDateTime;
use tokio::{fs, io::AsyncWriteExt};
use uuid::Uuid;

use crate::{
    api::PublisherApi,
    cli::UploadArgs,
    error::CliError,
    upload_part::{AllowedOrigins, PartSource, upload_parts},
};

#[derive(Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
struct ResumeDescriptor {
    schema_version: String,
    api_scope: String,
    release_id: Uuid,
    session_id: Uuid,
    artifact_id: Uuid,
    archive_sha256: String,
    size_bytes: u64,
    part_size_bytes: u64,
    create_idempotency_key: String,
}

pub async fn run(args: &UploadArgs, api: &PublisherApi) -> Result<Value, CliError> {
    let archive = canonical_file(&args.archive)?;
    let metadata = std::fs::metadata(&archive)?;
    if !metadata.is_file() || metadata.len() == 0 || metadata.len() > MAX_ARTIFACT_SIZE {
        return Err(CliError::Validation("archive size is invalid".to_owned()));
    }
    let part_size = args
        .part_size_mib
        .checked_mul(1024 * 1024)
        .filter(|value| (*value >= MIN_PART_SIZE) && *value <= 128 * 1024 * 1024)
        .ok_or_else(|| CliError::Validation("part size must be 5..128 MiB".to_owned()))?;
    let part_count = metadata.len().div_ceil(part_size);
    if part_count == 0 || part_count > u64::from(MAX_PARTS) {
        return Err(CliError::Validation(
            "archive requires too many parts".to_owned(),
        ));
    }
    let raw_digest = hash_file(archive.clone()).await?;
    let resume_path = resume_path(args, &archive)?;
    let descriptor = match read_descriptor(&resume_path).await? {
        Some(descriptor) => {
            validate_descriptor(&descriptor, args, metadata.len(), part_size, &raw_digest)?;
            descriptor
        }
        None => {
            let key = format!("publisher-upload-{}", Uuid::new_v4());
            let file_name = archive
                .file_name()
                .and_then(|value| value.to_str())
                .filter(|value| valid_zip_name(value))
                .ok_or_else(|| CliError::Validation("archive filename is invalid".to_owned()))?;
            let request = CreateUploadSessionRequest {
                file_name: file_name.to_owned(),
                media_type: "application/zip".to_owned(),
                size_bytes: metadata.len(),
                part_size_bytes: part_size,
                part_count: part_count as u16,
                expected_digest: ArtifactDigest {
                    algorithm: DigestAlgorithm::Sha256,
                    value: format!("sha256:{raw_digest}"),
                },
            };
            let session = api.create_upload(args.release_id, &key, &request).await?;
            validate_new_session(&session, args.release_id, &request)?;
            let descriptor = ResumeDescriptor {
                schema_version: "1.0".to_owned(),
                api_scope: api.scope().to_owned(),
                release_id: args.release_id,
                session_id: session.id,
                artifact_id: session.artifact_id,
                archive_sha256: raw_digest.clone(),
                size_bytes: metadata.len(),
                part_size_bytes: part_size,
                create_idempotency_key: key,
            };
            write_descriptor(&resume_path, &descriptor).await?;
            descriptor
        }
    };
    let status = api.upload_status(descriptor.session_id).await?;
    validate_status(&status, &descriptor)?;
    if status.status == ArtifactStatus::Uploaded {
        remove_descriptor(&resume_path).await?;
        return Ok(result(&descriptor, "uploaded", true));
    }
    if status.status != ArtifactStatus::PendingUpload
        || status.expires_at_epoch_seconds <= OffsetDateTime::now_utc().unix_timestamp() as u64
    {
        return Err(CliError::Conflict);
    }
    let origins = AllowedOrigins::new(&args.upload_origins, args.remote.allow_http)?;
    let parts = part_sources(&archive, descriptor.size_bytes, descriptor.part_size_bytes)?;
    let completed = upload_parts(
        api,
        &origins,
        descriptor.session_id,
        parts,
        &status.uploaded_parts,
    )
    .await?;
    let current_digest = hash_file(archive).await?;
    if current_digest != descriptor.archive_sha256 {
        return Err(CliError::Validation(
            "archive changed during upload".to_owned(),
        ));
    }
    let completed_session = api
        .complete_upload(
            descriptor.session_id,
            &CompleteUploadSessionRequest { parts: completed },
        )
        .await?;
    if completed_session.id != descriptor.session_id
        || completed_session.artifact_id != descriptor.artifact_id
        || completed_session.status != ArtifactStatus::Uploaded
    {
        return Err(CliError::PartialUpload);
    }
    remove_descriptor(&resume_path).await?;
    Ok(result(&descriptor, "uploaded", false))
}

fn part_sources(path: &Path, size: u64, part_size: u64) -> Result<Vec<PartSource>, CliError> {
    let count = size.div_ceil(part_size);
    (0..count)
        .map(|index| {
            let offset = index * part_size;
            Ok(PartSource {
                path: path.to_owned(),
                part_number: u16::try_from(index + 1)
                    .map_err(|_| CliError::Validation("too many parts".to_owned()))?,
                offset,
                size: (size - offset).min(part_size),
            })
        })
        .collect()
}

fn validate_new_session(
    session: &assetlibrary_contracts::UploadSession,
    release_id: Uuid,
    request: &CreateUploadSessionRequest,
) -> Result<(), CliError> {
    if session.id.is_nil()
        || session.artifact_id.is_nil()
        || session.release_id != release_id
        || session.status != ArtifactStatus::PendingUpload
        || session.part_size_bytes != request.part_size_bytes
        || session.max_parts != request.part_count
        || session.expected_digest != request.expected_digest
        || session.expires_at_epoch_seconds
            <= u64::try_from(OffsetDateTime::now_utc().unix_timestamp()).unwrap_or_default()
    {
        return Err(CliError::Validation(
            "invalid upload session response".to_owned(),
        ));
    }
    Ok(())
}

fn validate_status(
    status: &ResumableUploadSession,
    expected: &ResumeDescriptor,
) -> Result<(), CliError> {
    let expected_parts = expected.size_bytes.div_ceil(expected.part_size_bytes);
    if status.id != expected.session_id
        || status.release_id != expected.release_id
        || status.artifact_id != expected.artifact_id
        || status.size_bytes != expected.size_bytes
        || status.part_size_bytes != expected.part_size_bytes
        || u64::from(status.max_parts) != expected_parts
        || status.expected_digest.algorithm != DigestAlgorithm::Sha256
        || status.expected_digest.value != format!("sha256:{}", expected.archive_sha256)
        || !valid_uploaded_parts(status, expected_parts)
    {
        return Err(CliError::Validation(
            "upload recovery boundary changed".to_owned(),
        ));
    }
    Ok(())
}

fn valid_uploaded_parts(status: &ResumableUploadSession, expected_parts: u64) -> bool {
    let mut numbers = BTreeSet::new();
    status.uploaded_parts.iter().all(|part| {
        let is_last = u64::from(part.part_number) == expected_parts;
        let expected_size = if is_last {
            status.size_bytes - status.part_size_bytes * (expected_parts - 1)
        } else {
            status.part_size_bytes
        };
        let checksum = STANDARD.decode(&part.checksum_sha256_base64);
        part.part_number != 0
            && u64::from(part.part_number) <= expected_parts
            && numbers.insert(part.part_number)
            && part.size_bytes == expected_size
            && checksum.as_ref().is_ok_and(|bytes| {
                bytes.len() == 32 && STANDARD.encode(bytes) == part.checksum_sha256_base64
            })
            && !part.etag.is_empty()
            && part.etag.len() <= 200
            && part.etag.bytes().all(|byte| byte.is_ascii_graphic())
    })
}

fn validate_descriptor(
    value: &ResumeDescriptor,
    args: &UploadArgs,
    size: u64,
    part_size: u64,
    digest: &str,
) -> Result<(), CliError> {
    if value.schema_version != "1.0"
        || value.api_scope != normalized_scope(&args.remote.api_url)?
        || value.release_id != args.release_id
        || value.size_bytes != size
        || value.part_size_bytes != part_size
        || value.archive_sha256 != digest
        || value.session_id.is_nil()
        || value.artifact_id.is_nil()
    {
        return Err(CliError::Validation(
            "resume descriptor does not match this upload".to_owned(),
        ));
    }
    Ok(())
}

async fn hash_file(path: PathBuf) -> Result<String, CliError> {
    tokio::task::spawn_blocking(move || {
        assetlibrary_supply_chain::sha256_digest_file(&path, MAX_ARTIFACT_SIZE)
            .map(|(digest, _)| assetlibrary_supply_chain::hex_digest(&digest))
            .map_err(CliError::from)
    })
    .await
    .map_err(|_| CliError::Validation("archive hash task failed".to_owned()))?
}

async fn read_descriptor(path: &Path) -> Result<Option<ResumeDescriptor>, CliError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            return Err(CliError::Validation(
                "resume descriptor must be a regular file".to_owned(),
            ));
        }
        Ok(metadata) if metadata.len() > 16 * 1024 => {
            return Err(CliError::Validation(
                "resume descriptor is too large".to_owned(),
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    }
    match fs::read(path).await {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| CliError::Validation("resume descriptor is invalid".to_owned())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn write_descriptor(path: &Path, descriptor: &ResumeDescriptor) -> Result<(), CliError> {
    if fs::symlink_metadata(path).await.is_ok() {
        return Err(CliError::Conflict);
    }
    let temporary = path.with_extension(format!("upload.{}.tmp", Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .await?;
    file.write_all(&serde_json::to_vec(descriptor).map_err(|_| CliError::PartialUpload)?)
        .await?;
    file.sync_all().await?;
    let link_result = fs::hard_link(&temporary, path).await;
    let cleanup_result = fs::remove_file(&temporary).await;
    link_result?;
    cleanup_result?;
    Ok(())
}

async fn remove_descriptor(path: &Path) -> Result<(), CliError> {
    if let Ok(metadata) = fs::symlink_metadata(path).await
        && (metadata.file_type().is_symlink() || !metadata.is_file())
    {
        return Err(CliError::Validation(
            "resume descriptor must be a regular file".to_owned(),
        ));
    }
    match fs::remove_file(path).await {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

fn result(descriptor: &ResumeDescriptor, status: &str, replayed: bool) -> Value {
    json!({"command":"upload","release_id":descriptor.release_id,"artifact_id":descriptor.artifact_id,
        "session_id":descriptor.session_id,"archive_sha256":descriptor.archive_sha256,
        "size_bytes":descriptor.size_bytes,"status":status,"replayed":replayed})
}

fn canonical_file(path: &Path) -> Result<PathBuf, CliError> {
    if std::fs::symlink_metadata(path)?.file_type().is_symlink() {
        return Err(CliError::Validation(
            "archive cannot be a symlink".to_owned(),
        ));
    }
    let path = std::fs::canonicalize(path)?;
    if !std::fs::metadata(&path)?.is_file() {
        return Err(CliError::Validation(
            "archive must be a regular file".to_owned(),
        ));
    }
    Ok(path)
}

fn resume_path(args: &UploadArgs, archive: &Path) -> Result<PathBuf, CliError> {
    let requested = args
        .resume_file
        .clone()
        .unwrap_or_else(|| archive.with_extension("zip.upload.json"));
    let absolute = if requested.is_absolute() {
        requested
    } else {
        std::env::current_dir()?.join(requested)
    };
    let name = absolute
        .file_name()
        .and_then(|value| value.to_str())
        .filter(|value| value.ends_with(".upload.json") && valid_resume_name(value))
        .ok_or_else(|| CliError::Validation("resume filename is invalid".to_owned()))?;
    let parent = absolute
        .parent()
        .ok_or(CliError::Configuration("resume path has no parent"))?;
    let parent = std::fs::canonicalize(parent)?;
    if archive.parent() != Some(parent.as_path()) {
        return Err(CliError::Validation(
            "resume descriptor must be beside the archive".to_owned(),
        ));
    }
    Ok(parent.join(name))
}

fn valid_resume_name(value: &str) -> bool {
    (1..=255).contains(&value.len())
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn valid_zip_name(value: &str) -> bool {
    (1..=240).contains(&value.len())
        && !value.starts_with('.')
        && value.ends_with(".zip")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
}

fn normalized_scope(value: &str) -> Result<String, CliError> {
    let mut url = url::Url::parse(value).map_err(|_| CliError::Configuration("invalid API URL"))?;
    url.set_query(None);
    url.set_fragment(None);
    Ok(url.as_str().trim_end_matches('/').to_owned())
}
