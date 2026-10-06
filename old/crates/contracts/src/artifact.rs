use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use uuid::Uuid;

pub const MAX_PARTS: u16 = 10_000;
pub const MIN_PART_SIZE: u64 = 5 * 1024 * 1024;
pub const MAX_ARTIFACT_SIZE: u64 = 2 * 1024 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ArtifactStatus {
    PendingUpload,
    Uploaded,
    Scanning,
    Verified,
    Quarantined,
    Deleted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactDigest {
    pub algorithm: DigestAlgorithm,
    pub value: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateUploadSessionRequest {
    pub file_name: String,
    pub media_type: String,
    pub size_bytes: u64,
    pub part_size_bytes: u64,
    pub part_count: u16,
    pub expected_digest: ArtifactDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum DigestAlgorithm {
    #[serde(rename = "sha256")]
    Sha256,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UploadSession {
    pub id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub object_key: String,
    pub part_size_bytes: u64,
    pub max_parts: u16,
    pub expires_at_epoch_seconds: u64,
    pub status: ArtifactStatus,
    pub expected_digest: ArtifactDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UploadedPart {
    pub part_number: u16,
    pub etag: String,
    pub checksum_sha256_base64: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResumableUploadSession {
    pub id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub part_size_bytes: u64,
    pub max_parts: u16,
    pub size_bytes: u64,
    pub expires_at_epoch_seconds: u64,
    pub status: ArtifactStatus,
    pub expected_digest: ArtifactDigest,
    pub uploaded_parts: Vec<UploadedPart>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PresignUploadPartRequest {
    pub size_bytes: u64,
    pub checksum_sha256_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PresignedUploadPart {
    pub part_number: u16,
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteUploadPart {
    pub part_number: u16,
    pub etag: String,
    pub checksum_sha256_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CompleteUploadSessionRequest {
    pub parts: Vec<CompleteUploadPart>,
}

impl UploadSession {
    pub fn validate_part(
        &self,
        part_number: u16,
        size_bytes: u64,
        is_last: bool,
    ) -> Result<(), UploadError> {
        if part_number == 0 || part_number > self.max_parts || self.max_parts > MAX_PARTS {
            return Err(UploadError::InvalidPartNumber);
        }
        if size_bytes == 0 || size_bytes > MAX_ARTIFACT_SIZE {
            return Err(UploadError::InvalidPartSize);
        }
        if size_bytes > self.part_size_bytes {
            return Err(UploadError::InvalidPartSize);
        }
        if !is_last && size_bytes < self.part_size_bytes.max(MIN_PART_SIZE) {
            return Err(UploadError::NonFinalPartTooSmall);
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UploadError {
    InvalidPartNumber,
    InvalidPartSize,
    NonFinalPartTooSmall,
}
