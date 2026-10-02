use assetlibrary_telemetry::record_dependency;
use async_trait::async_trait;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::future::Future;
use std::path::Path;
use std::time::Instant;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

mod multipart;
#[cfg(test)]
mod sdk_retry_tests;

#[derive(Clone, Debug)]
pub struct ObjectStoreConfig {
    pub endpoint_url: Option<String>,
    pub region: String,
    pub quarantine_bucket: String,
    pub published_bucket: String,
    pub force_path_style: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PresignedRequest {
    pub method: String,
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub expires_in_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletedPart {
    pub part_number: u16,
    pub etag: String,
    pub checksum_sha256_base64: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UploadedPart {
    pub part_number: u16,
    pub etag: String,
    pub checksum_sha256_base64: String,
    pub size_bytes: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingMultipartUpload {
    pub object_key: String,
    pub upload_id: String,
    pub initiated_epoch_seconds: i64,
}

#[derive(Debug, thiserror::Error)]
pub enum ObjectStoreError {
    #[error("object store configuration is invalid")]
    InvalidConfiguration,
    #[error("object store request failed")]
    RequestFailed,
    #[error("object exceeds requested byte limit")]
    ObjectTooLarge,
    #[error("published object conflicts with immutable content")]
    PublishedConflict,
}

#[async_trait]
pub trait ObjectStore: Send + Sync {
    async fn create_quarantine_upload(
        &self,
        object_key: &str,
        media_type: &str,
    ) -> Result<String, ObjectStoreError>;

    async fn presign_upload_part(
        &self,
        object_key: &str,
        upload_id: &str,
        part_number: u16,
        content_length: u64,
        checksum_sha256_base64: &str,
    ) -> Result<PresignedRequest, ObjectStoreError>;

    async fn abort_quarantine_upload(
        &self,
        object_key: &str,
        upload_id: &str,
    ) -> Result<(), ObjectStoreError>;

    async fn list_quarantine_upload_parts(
        &self,
        object_key: &str,
        upload_id: &str,
    ) -> Result<Vec<UploadedPart>, ObjectStoreError>;

    async fn list_quarantine_multipart_uploads(
        &self,
        maximum_items: usize,
    ) -> Result<Vec<PendingMultipartUpload>, ObjectStoreError>;

    async fn delete_quarantine_object(&self, object_key: &str) -> Result<(), ObjectStoreError>;

    async fn complete_quarantine_upload(
        &self,
        object_key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
        expected_size: u64,
        expected_sha256_hex: &str,
    ) -> Result<(), ObjectStoreError>;

    async fn download_quarantine_object(
        &self,
        object_key: &str,
        destination: &Path,
        maximum_bytes: u64,
    ) -> Result<u64, ObjectStoreError>;

    async fn put_verified_object(
        &self,
        source: &Path,
        address_sha256_hex: &str,
        content_sha256_hex: &str,
        content_sha256_base64: &str,
        media_type: &str,
    ) -> Result<String, ObjectStoreError>;
}

pub struct S3ObjectStore {
    client: aws_sdk_s3::Client,
    quarantine_bucket: String,
    published_bucket: String,
    r2_multipart: bool,
}

impl S3ObjectStore {
    pub async fn new(config: ObjectStoreConfig) -> Result<Self, ObjectStoreError> {
        if config.region.is_empty()
            || config.quarantine_bucket.is_empty()
            || config.published_bucket.is_empty()
            || config.endpoint_url.as_deref().is_some_and(|value| {
                !value.starts_with("https://") && !value.starts_with("http://127.0.0.1:")
            })
        {
            return Err(ObjectStoreError::InvalidConfiguration);
        }
        let r2_multipart = multipart::is_r2_endpoint(config.endpoint_url.as_deref());
        let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(aws_config::Region::new(config.region))
            .load()
            .await;
        let mut builder =
            aws_sdk_s3::config::Builder::from(&shared).force_path_style(config.force_path_style);
        if let Some(endpoint_url) = config.endpoint_url {
            builder = builder.endpoint_url(endpoint_url);
        }
        Ok(Self {
            client: aws_sdk_s3::Client::from_conf(builder.build()),
            quarantine_bucket: config.quarantine_bucket,
            published_bucket: config.published_bucket,
            r2_multipart,
        })
    }

    async fn published_object_matches(
        &self,
        key: &str,
        size: u64,
        sha256_hex: &str,
    ) -> Result<bool, ObjectStoreError> {
        let existing = self
            .client
            .head_object()
            .bucket(&self.published_bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| ObjectStoreError::RequestFailed)?;
        let matching_length = existing
            .content_length()
            .is_some_and(|value| value >= 0 && value as u64 == size);
        let matching_metadata = existing
            .metadata()
            .and_then(|metadata| metadata.get("sha256"))
            .is_some_and(|value| value == sha256_hex);
        if !matching_length || !matching_metadata {
            return Ok(false);
        }

        let output = self
            .client
            .get_object()
            .bucket(&self.published_bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| ObjectStoreError::RequestFailed)?;
        let mut source = output.body.into_async_read().take(size + 1);
        let mut hasher = Sha256::new();
        let mut actual_size = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|_| ObjectStoreError::RequestFailed)?;
            if read == 0 {
                break;
            }
            actual_size += read as u64;
            hasher.update(&buffer[..read]);
        }
        let actual_digest = hex::encode(hasher.finalize());
        Ok(actual_size == size && actual_digest == sha256_hex)
    }

    async fn quarantine_object_matches(
        &self,
        key: &str,
        size: u64,
        sha256_hex: &str,
    ) -> Result<bool, ObjectStoreError> {
        if size == 0
            || sha256_hex.len() != 64
            || !sha256_hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(ObjectStoreError::InvalidConfiguration);
        }
        let existing = self
            .client
            .head_object()
            .bucket(&self.quarantine_bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| ObjectStoreError::RequestFailed)?;
        if !existing
            .content_length()
            .is_some_and(|value| value >= 0 && value as u64 == size)
        {
            return Ok(false);
        }

        let output = self
            .client
            .get_object()
            .bucket(&self.quarantine_bucket)
            .key(key)
            .send()
            .await
            .map_err(|_| ObjectStoreError::RequestFailed)?;
        let mut source = output.body.into_async_read().take(size + 1);
        let mut hasher = Sha256::new();
        let mut actual_size = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = source
                .read(&mut buffer)
                .await
                .map_err(|_| ObjectStoreError::RequestFailed)?;
            if read == 0 {
                break;
            }
            actual_size += read as u64;
            hasher.update(&buffer[..read]);
        }
        Ok(actual_size == size && hex::encode(hasher.finalize()) == sha256_hex)
    }
}

#[async_trait]
impl ObjectStore for S3ObjectStore {
    async fn create_quarantine_upload(
        &self,
        object_key: &str,
        media_type: &str,
    ) -> Result<String, ObjectStoreError> {
        observe_s3("create_multipart_upload", async {
            let output = self
                .client
                .create_multipart_upload()
                .bucket(&self.quarantine_bucket)
                .key(object_key)
                .content_type(media_type)
                .send()
                .await
                .map_err(|_| ObjectStoreError::RequestFailed)?;
            output
                .upload_id()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or(ObjectStoreError::RequestFailed)
        })
        .await
    }

    async fn presign_upload_part(
        &self,
        object_key: &str,
        upload_id: &str,
        part_number: u16,
        content_length: u64,
        checksum_sha256_base64: &str,
    ) -> Result<PresignedRequest, ObjectStoreError> {
        observe_s3(
            "presign_upload_part",
            self.presign_part_request(
                object_key,
                upload_id,
                part_number,
                content_length,
                checksum_sha256_base64,
            ),
        )
        .await
    }

    async fn abort_quarantine_upload(
        &self,
        object_key: &str,
        upload_id: &str,
    ) -> Result<(), ObjectStoreError> {
        observe_s3("abort_multipart_upload", async {
            let result = self
                .client
                .abort_multipart_upload()
                .bucket(&self.quarantine_bucket)
                .key(object_key)
                .upload_id(upload_id)
                .send()
                .await;
            match result {
                Ok(_) => Ok(()),
                Err(error)
                    if error
                        .as_service_error()
                        .is_some_and(|service| service.is_no_such_upload()) =>
                {
                    Ok(())
                }
                Err(_) => Err(ObjectStoreError::RequestFailed),
            }
        })
        .await
    }

    async fn list_quarantine_upload_parts(
        &self,
        object_key: &str,
        upload_id: &str,
    ) -> Result<Vec<UploadedPart>, ObjectStoreError> {
        observe_s3("list_parts", async {
            let mut uploaded = Vec::new();
            let mut marker = None;
            loop {
                let output = self
                    .client
                    .list_parts()
                    .bucket(&self.quarantine_bucket)
                    .key(object_key)
                    .upload_id(upload_id)
                    .max_parts(1_000)
                    .set_part_number_marker(marker.clone())
                    .send()
                    .await
                    .map_err(|_| ObjectStoreError::RequestFailed)?;
                for part in output.parts() {
                    let (Some(number), Some(etag), Some(checksum), Some(size)) = (
                        part.part_number(),
                        part.e_tag(),
                        part.checksum_sha256(),
                        part.size(),
                    ) else {
                        // R2 omits part SHA-256. Re-upload rather than trusting an ETag.
                        continue;
                    };
                    let Ok(part_number) = u16::try_from(number) else {
                        continue;
                    };
                    let Ok(size_bytes) = u64::try_from(size) else {
                        continue;
                    };
                    uploaded.push(UploadedPart {
                        part_number,
                        etag: etag.to_owned(),
                        checksum_sha256_base64: checksum.to_owned(),
                        size_bytes,
                    });
                }
                if output.is_truncated() != Some(true) {
                    break;
                }
                let next = output.next_part_number_marker().map(str::to_owned);
                if next.is_none() || next == marker {
                    return Err(ObjectStoreError::RequestFailed);
                }
                marker = next;
            }
            uploaded.sort_unstable_by_key(|part| part.part_number);
            Ok(uploaded)
        })
        .await
    }

    async fn list_quarantine_multipart_uploads(
        &self,
        maximum_items: usize,
    ) -> Result<Vec<PendingMultipartUpload>, ObjectStoreError> {
        if maximum_items == 0 || maximum_items > 10_000 {
            return Err(ObjectStoreError::InvalidConfiguration);
        }
        observe_s3("list_multipart_uploads", async {
            let mut uploads = Vec::with_capacity(maximum_items.min(1_000));
            let mut key_marker = None;
            let mut upload_id_marker = None;
            while uploads.len() < maximum_items {
                let remaining = maximum_items - uploads.len();
                let output = self
                    .client
                    .list_multipart_uploads()
                    .bucket(&self.quarantine_bucket)
                    .max_uploads(
                        i32::try_from(remaining.min(1_000))
                            .map_err(|_| ObjectStoreError::InvalidConfiguration)?,
                    )
                    .set_key_marker(key_marker.clone())
                    .set_upload_id_marker(upload_id_marker.clone())
                    .send()
                    .await
                    .map_err(|_| ObjectStoreError::RequestFailed)?;
                for upload in output.uploads() {
                    let (Some(object_key), Some(upload_id), Some(initiated)) =
                        (upload.key(), upload.upload_id(), upload.initiated())
                    else {
                        continue;
                    };
                    if !object_key.starts_with("quarantine/") {
                        continue;
                    }
                    uploads.push(PendingMultipartUpload {
                        object_key: object_key.to_owned(),
                        upload_id: upload_id.to_owned(),
                        initiated_epoch_seconds: initiated.secs(),
                    });
                }
                if output.is_truncated() != Some(true) {
                    break;
                }
                let next = (
                    output.next_key_marker().map(str::to_owned),
                    output.next_upload_id_marker().map(str::to_owned),
                );
                if next.0.is_none() || next == (key_marker.clone(), upload_id_marker.clone()) {
                    return Err(ObjectStoreError::RequestFailed);
                }
                key_marker = next.0;
                upload_id_marker = next.1;
            }
            uploads.truncate(maximum_items);
            Ok(uploads)
        })
        .await
    }

    async fn delete_quarantine_object(&self, object_key: &str) -> Result<(), ObjectStoreError> {
        observe_s3("delete_object", async {
            self.client
                .delete_object()
                .bucket(&self.quarantine_bucket)
                .key(object_key)
                .send()
                .await
                .map_err(|_| ObjectStoreError::RequestFailed)?;
            Ok(())
        })
        .await
    }

    async fn complete_quarantine_upload(
        &self,
        object_key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
        expected_size: u64,
        expected_sha256_hex: &str,
    ) -> Result<(), ObjectStoreError> {
        let mut multipart = aws_sdk_s3::types::CompletedMultipartUpload::builder();
        for part in parts {
            multipart = multipart.parts(
                aws_sdk_s3::types::CompletedPart::builder()
                    .part_number(i32::from(part.part_number))
                    .e_tag(&part.etag)
                    .set_checksum_sha256(
                        (!self.r2_multipart).then(|| part.checksum_sha256_base64.clone()),
                    )
                    .build(),
            );
        }
        observe_s3("complete_multipart_upload", async {
            let result = self
                .client
                .complete_multipart_upload()
                .bucket(&self.quarantine_bucket)
                .key(object_key)
                .upload_id(upload_id)
                .multipart_upload(multipart.build())
                .send()
                .await;
            if result.is_err()
                && !self
                    .quarantine_object_matches(object_key, expected_size, expected_sha256_hex)
                    .await
                    .unwrap_or(false)
            {
                return Err(ObjectStoreError::RequestFailed);
            }
            Ok(())
        })
        .await
    }

    async fn download_quarantine_object(
        &self,
        object_key: &str,
        destination: &Path,
        maximum_bytes: u64,
    ) -> Result<u64, ObjectStoreError> {
        if maximum_bytes == 0 || maximum_bytes > i64::MAX as u64 {
            return Err(ObjectStoreError::InvalidConfiguration);
        }
        observe_s3("get_object", async {
            let output = self
                .client
                .get_object()
                .bucket(&self.quarantine_bucket)
                .key(object_key)
                .send()
                .await
                .map_err(|_| ObjectStoreError::RequestFailed)?;
            if output
                .content_length()
                .is_some_and(|length| length < 0 || length as u64 > maximum_bytes)
            {
                return Err(ObjectStoreError::ObjectTooLarge);
            }

            let mut source = output.body.into_async_read().take(maximum_bytes + 1);
            let mut target = tokio::fs::OpenOptions::new()
                .create_new(true)
                .write(true)
                .open(destination)
                .await
                .map_err(|_| ObjectStoreError::RequestFailed)?;
            let copied = match tokio::io::copy(&mut source, &mut target).await {
                Ok(copied) => copied,
                Err(_) => {
                    drop(target);
                    let _ = tokio::fs::remove_file(destination).await;
                    return Err(ObjectStoreError::RequestFailed);
                }
            };
            if copied > maximum_bytes {
                drop(target);
                let _ = tokio::fs::remove_file(destination).await;
                return Err(ObjectStoreError::ObjectTooLarge);
            }
            if target.flush().await.is_err() {
                drop(target);
                let _ = tokio::fs::remove_file(destination).await;
                return Err(ObjectStoreError::RequestFailed);
            }
            Ok(copied)
        })
        .await
    }

    async fn put_verified_object(
        &self,
        source: &Path,
        address_sha256_hex: &str,
        content_sha256_hex: &str,
        content_sha256_base64: &str,
        media_type: &str,
    ) -> Result<String, ObjectStoreError> {
        if !valid_sha256_hex(address_sha256_hex)
            || !valid_sha256_hex(content_sha256_hex)
            || content_sha256_base64.len() != 44
            || media_type.is_empty()
        {
            return Err(ObjectStoreError::InvalidConfiguration);
        }
        let size = tokio::fs::metadata(source)
            .await
            .map_err(|_| ObjectStoreError::RequestFailed)?
            .len();
        let key = published_object_key(address_sha256_hex);
        let body = aws_sdk_s3::primitives::ByteStream::from_path(source)
            .await
            .map_err(|_| ObjectStoreError::RequestFailed)?;
        observe_s3("put_object", async {
            let result = self
                .client
                .put_object()
                .bucket(&self.published_bucket)
                .key(&key)
                .body(body)
                .content_type(media_type)
                .checksum_sha256(content_sha256_base64)
                .metadata("sha256", content_sha256_hex)
                .metadata("canonical-sha256", address_sha256_hex)
                .if_none_match("*")
                .send()
                .await;
            if result.is_ok() {
                return Ok(key);
            }
            if !self
                .published_object_matches(&key, size, content_sha256_hex)
                .await?
            {
                return Err(ObjectStoreError::PublishedConflict);
            }
            Ok(key)
        })
        .await
    }
}

async fn observe_s3<T>(
    operation: &'static str,
    work: impl Future<Output = Result<T, ObjectStoreError>>,
) -> Result<T, ObjectStoreError> {
    let started = Instant::now();
    let result = work.await;
    let outcome = if result.is_ok() { "success" } else { "error" };
    record_dependency("s3", operation, outcome, started.elapsed());
    result
}

fn valid_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn published_object_key(address_sha256_hex: &str) -> String {
    format!("sha256/{}/{}", &address_sha256_hex[..2], address_sha256_hex)
}

#[cfg(test)]
mod tests {
    use super::{ObjectStoreConfig, ObjectStoreError, S3ObjectStore, published_object_key};

    #[test]
    fn published_key_uses_canonical_address_not_raw_content_digest() {
        let canonical = "ab".repeat(32);
        let raw = "cd".repeat(32);
        let key = published_object_key(&canonical);
        assert_eq!(key, format!("sha256/ab/{canonical}"));
        assert!(!key.contains(&raw));
    }

    #[tokio::test]
    async fn rejects_non_local_plaintext_endpoint() {
        let result = S3ObjectStore::new(ObjectStoreConfig {
            endpoint_url: Some("http://objects.example".into()),
            region: "auto".into(),
            quarantine_bucket: "quarantine".into(),
            published_bucket: "published".into(),
            force_path_style: true,
        })
        .await;
        assert!(matches!(
            result,
            Err(ObjectStoreError::InvalidConfiguration)
        ));
    }
}
