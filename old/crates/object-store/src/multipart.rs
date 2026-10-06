//! R2 validates signed payload SHA-256 but rejects UploadPart checksum headers.

use aws_sdk_s3::presigning::PresigningConfig;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::time::Duration;

use crate::{ObjectStoreError, PresignedRequest, S3ObjectStore};

pub(crate) fn is_r2_endpoint(endpoint: Option<&str>) -> bool {
    endpoint
        .and_then(|value| url::Url::parse(value).ok())
        .is_some_and(|url| {
            url.scheme() == "https"
                && url
                    .host_str()
                    .is_some_and(|host| host.ends_with(".r2.cloudflarestorage.com"))
        })
}

impl S3ObjectStore {
    pub(crate) async fn presign_part_request(
        &self,
        object_key: &str,
        upload_id: &str,
        part_number: u16,
        content_length: u64,
        checksum: &str,
    ) -> Result<PresignedRequest, ObjectStoreError> {
        let digest = STANDARD
            .decode(checksum)
            .map_err(|_| ObjectStoreError::InvalidConfiguration)?;
        if part_number == 0 || digest.len() != 32 || STANDARD.encode(&digest) != checksum {
            return Err(ObjectStoreError::InvalidConfiguration);
        }
        let expires = Duration::from_secs(900);
        let config = PresigningConfig::expires_in(expires)
            .map_err(|_| ObjectStoreError::InvalidConfiguration)?;
        let builder = self
            .client
            .upload_part()
            .bucket(&self.quarantine_bucket)
            .key(object_key)
            .upload_id(upload_id)
            .part_number(i32::from(part_number))
            .content_length(
                i64::try_from(content_length)
                    .map_err(|_| ObjectStoreError::InvalidConfiguration)?,
            );
        let request = if self.r2_multipart {
            let hex: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
            // The header is signed, and R2 rejects bytes that do not match it.
            // Never fall back to an unsigned body when a provider rejects SHA-256.
            builder
                .customize()
                .mutate_request(move |request| {
                    request
                        .headers_mut()
                        .insert("x-amz-content-sha256", hex.clone());
                })
                .presigned(config)
                .await
        } else {
            builder.checksum_sha256(checksum).presigned(config).await
        }
        .map_err(|_| ObjectStoreError::RequestFailed)?;
        Ok(PresignedRequest {
            method: request.method().to_owned(),
            url: request.uri().to_owned(),
            headers: request
                .headers()
                .map(|(name, value)| (name.to_owned(), value.to_owned()))
                .collect(),
            expires_in_seconds: expires.as_secs(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(r2_multipart: bool) -> S3ObjectStore {
        let config = aws_sdk_s3::Config::builder()
            .behavior_version_latest()
            .region(aws_sdk_s3::config::Region::new("auto"))
            .credentials_provider(aws_sdk_s3::config::Credentials::new(
                "test-access",
                "test-secret",
                None,
                None,
                "unit-test",
            ))
            .endpoint_url("https://account.r2.cloudflarestorage.com")
            .force_path_style(true)
            .build();
        S3ObjectStore {
            client: aws_sdk_s3::Client::from_conf(config),
            quarantine_bucket: "quarantine".into(),
            published_bucket: "published".into(),
            r2_multipart,
        }
    }

    #[tokio::test]
    async fn r2_presign_binds_payload_digest_without_unsupported_checksum_header() {
        let request = store(true)
            .presign_part_request(
                "quarantine/test",
                "upload",
                1,
                3,
                &STANDARD.encode([0xab; 32]),
            )
            .await
            .unwrap();
        assert_eq!(request.headers["x-amz-content-sha256"], "ab".repeat(32));
        assert!(!request.headers.contains_key("x-amz-checksum-sha256"));
        let url = url::Url::parse(&request.url).unwrap();
        let signed_headers = url
            .query_pairs()
            .find(|(key, _)| key == "X-Amz-SignedHeaders")
            .unwrap()
            .1;
        assert!(
            signed_headers
                .split(';')
                .any(|name| name == "x-amz-content-sha256")
        );
        assert!(
            signed_headers
                .split(';')
                .any(|name| name == "content-length")
        );
    }

    #[tokio::test]
    async fn other_s3_providers_retain_standard_checksum_presigning() {
        let checksum = STANDARD.encode([0xab; 32]);
        let request = store(false)
            .presign_part_request("quarantine/test", "upload", 1, 3, &checksum)
            .await
            .unwrap();
        assert_eq!(request.headers["x-amz-checksum-sha256"], checksum);
    }

    #[tokio::test]
    async fn invalid_digest_cannot_be_presigned() {
        for digest in ["!".repeat(44), STANDARD.encode([0xab; 31])] {
            assert!(matches!(
                store(true)
                    .presign_part_request("key", "upload", 1, 3, &digest)
                    .await,
                Err(ObjectStoreError::InvalidConfiguration)
            ));
        }
    }

    #[test]
    fn endpoint_detection_uses_the_https_hostname() {
        assert!(is_r2_endpoint(Some(
            "https://account.r2.cloudflarestorage.com"
        )));
        for endpoint in [
            "https://r2.cloudflarestorage.com.attacker.test",
            "https://objects.test/r2.cloudflarestorage.com",
            "http://account.r2.cloudflarestorage.com",
        ] {
            assert!(!is_r2_endpoint(Some(endpoint)));
        }
        assert!(!is_r2_endpoint(None));
    }
}
