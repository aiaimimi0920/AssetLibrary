use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{PublishedPackage, SCHEMA_VERSION_V1, events::plausible_rfc3339};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SearchPackageDocument {
    pub schema_version: String,
    pub package: PublishedPackage,
    pub description: String,
    pub tags: Vec<String>,
    pub release_id: Uuid,
    pub version: String,
    pub artifact_id: Uuid,
    pub signing_key_id: String,
    pub digest: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub file_name: String,
    pub updated_at: String,
}

impl SearchPackageDocument {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.description.len() <= 100_000
            && self.tags.len() <= 32
            && self
                .tags
                .iter()
                .all(|tag| !tag.is_empty() && tag.len() <= 100)
            && !self.release_id.is_nil()
            && !self.artifact_id.is_nil()
            && !self.signing_key_id.is_empty()
            && self.signing_key_id.len() <= 200
            && self
                .signing_key_id
                .bytes()
                .all(|byte| byte.is_ascii_graphic())
            && self.digest.len() == 64
            && self
                .digest
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            && self.size_bytes > 0
            && !self.version.is_empty()
            && self.version.len() <= 100
            && !self.media_type.is_empty()
            && self.media_type.len() <= 200
            && !self.file_name.is_empty()
            && self.file_name.len() <= 180
            && plausible_rfc3339(&self.updated_at)
    }
}
