use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{SCHEMA_VERSION_V1, events::plausible_rfc3339};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DownloadClientType {
    Web,
    Loom,
    Hook,
    Cli,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateDownloadSessionRequest {
    pub client_type: DownloadClientType,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadArtifact {
    pub artifact_id: Uuid,
    pub release_id: Uuid,
    pub digest: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub file_name: String,
}

impl DownloadArtifact {
    pub fn validate(&self) -> bool {
        !self.artifact_id.is_nil()
            && !self.release_id.is_nil()
            && self.digest.len() == 64
            && self
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && self.size_bytes > 0
            && !self.media_type.is_empty()
            && self.media_type.len() <= 200
            && safe_file_name(&self.file_name)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicDownload {
    pub schema_version: String,
    pub artifact: DownloadArtifact,
    pub download_url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadSession {
    pub schema_version: String,
    pub session_id: Uuid,
    pub artifact: DownloadArtifact,
    pub download_url: String,
    pub access_token: String,
    pub expires_at: String,
}

impl DownloadSession {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && !self.session_id.is_nil()
            && self.artifact.validate()
            && matches!(
                self.download_url.strip_prefix("https://").or_else(|| self.download_url.strip_prefix("http://")),
                Some(rest) if !rest.is_empty()
            )
            && (64..=4096).contains(&self.access_token.len())
            && self.access_token.starts_with("v1.")
            && plausible_rfc3339(&self.expires_at)
    }
}

fn safe_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 180
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        && value != "."
        && value != ".."
}

#[cfg(test)]
mod tests {
    use super::DownloadArtifact;
    use uuid::Uuid;

    #[test]
    fn artifact_requires_canonical_digest_and_safe_filename() {
        let mut artifact = DownloadArtifact {
            artifact_id: Uuid::new_v4(),
            release_id: Uuid::new_v4(),
            digest: "a".repeat(64),
            size_bytes: 42,
            media_type: "application/zip".to_owned(),
            file_name: "example-1.0.0.zip".to_owned(),
        };
        assert!(artifact.validate());
        artifact.file_name = "../escape.zip".to_owned();
        assert!(!artifact.validate());
    }
}
