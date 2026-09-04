use assetlibrary_contracts::{
    DigestAlgorithm, MAX_ARTIFACT_SIZE, MAX_PARTS, MIN_PART_SIZE, UploadError,
};
use sha2::{Digest, Sha256};

pub fn validate_upload_request(
    size_bytes: u64,
    part_size_bytes: u64,
    part_count: u16,
) -> Result<(), UploadError> {
    if size_bytes == 0
        || size_bytes > MAX_ARTIFACT_SIZE
        || part_count == 0
        || part_count > MAX_PARTS
    {
        return Err(UploadError::InvalidPartSize);
    }
    if part_size_bytes < MIN_PART_SIZE || part_size_bytes > MAX_ARTIFACT_SIZE {
        return Err(UploadError::InvalidPartSize);
    }
    let expected_parts = size_bytes.div_ceil(part_size_bytes);
    if expected_parts != u64::from(part_count) {
        return Err(UploadError::InvalidPartSize);
    }
    Ok(())
}

pub fn validate_artifact_file_name(file_name: &str) -> bool {
    !file_name.is_empty()
        && file_name.len() <= 240
        && !file_name.starts_with('.')
        && file_name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        && file_name.ends_with(".zip")
}

pub fn validate_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub fn request_digest(
    release_id: uuid::Uuid,
    request: &assetlibrary_contracts::CreateUploadSessionRequest,
) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(release_id.as_bytes());
    hasher.update(serde_json::to_vec(request).expect("contract request serialization cannot fail"));
    hasher.finalize().into()
}

pub fn validate_create_request(
    request: &assetlibrary_contracts::CreateUploadSessionRequest,
) -> Result<(), UploadError> {
    if !validate_artifact_file_name(&request.file_name)
        || !matches!(
            request.media_type.as_str(),
            "application/zip" | "application/x-zip-compressed" | "application/octet-stream"
        )
        || request.expected_digest.algorithm != DigestAlgorithm::Sha256
        || !validate_sha256(&request.expected_digest.value)
    {
        return Err(UploadError::InvalidPartSize);
    }
    validate_upload_request(
        request.size_bytes,
        request.part_size_bytes,
        request.part_count,
    )
}

#[cfg(test)]
mod tests {
    use super::{validate_artifact_file_name, validate_sha256, validate_upload_request};
    use assetlibrary_contracts::{MAX_ARTIFACT_SIZE, UploadError};

    #[test]
    fn upload_bounds_are_enforced() {
        assert!(validate_upload_request(10 * 1024 * 1024, 5 * 1024 * 1024, 2).is_ok());
        assert_eq!(
            validate_upload_request(1, 1, 1),
            Err(UploadError::InvalidPartSize)
        );
        assert!(validate_upload_request(11 * 1024 * 1024, 5 * 1024 * 1024, 3).is_ok());
        assert!(validate_upload_request(11 * 1024 * 1024, 5 * 1024 * 1024, 2).is_err());
        assert!(validate_upload_request(MAX_ARTIFACT_SIZE, MAX_ARTIFACT_SIZE, 1).is_ok());
        assert!(validate_upload_request(MAX_ARTIFACT_SIZE + 1, MAX_ARTIFACT_SIZE, 2).is_err());
    }

    #[test]
    fn artifact_metadata_is_restricted() {
        assert!(validate_artifact_file_name("package-1.0.0.zip"));
        assert!(!validate_artifact_file_name("../package.zip"));
        assert!(!validate_artifact_file_name("nested/package.zip"));
        assert!(!validate_artifact_file_name("package.tar"));
        assert!(validate_sha256(
            "sha256:8671e233a7d3afb943109ea0094c03894bf405e06ff5d7022ad0e814d8a15a50"
        ));
        assert!(!validate_sha256("sha256:ABC"));
    }
}
