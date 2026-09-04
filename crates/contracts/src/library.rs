use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{PublishedPackage, SCHEMA_VERSION_V1, events::plausible_rfc3339};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum LibraryEntryStatus {
    Listed,
    Hidden,
    Removed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateLibraryEntryRequest {
    pub status: LibraryEntryStatus,
    pub favorite: bool,
    pub installed_release_id: Option<Uuid>,
    pub installed_artifact_id: Option<Uuid>,
}

impl UpdateLibraryEntryRequest {
    pub fn validate(&self) -> bool {
        self.installed_release_id.is_some() == self.installed_artifact_id.is_some()
            && self.installed_release_id.is_none_or(|id| !id.is_nil())
            && self.installed_artifact_id.is_none_or(|id| !id.is_nil())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryEntry {
    pub package: PublishedPackage,
    pub status: LibraryEntryStatus,
    pub favorite: bool,
    pub installed_release_id: Option<Uuid>,
    pub installed_artifact_id: Option<Uuid>,
    pub updated_at: String,
}

impl LibraryEntry {
    pub fn validate(&self) -> bool {
        self.installed_release_id.is_some() == self.installed_artifact_id.is_some()
            && plausible_rfc3339(&self.updated_at)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryPage {
    pub schema_version: String,
    pub items: Vec<LibraryEntry>,
    pub next_cursor: Option<String>,
}

impl LibraryPage {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1 && self.items.iter().all(LibraryEntry::validate)
    }
}

#[cfg(test)]
mod tests {
    use super::{LibraryEntryStatus, UpdateLibraryEntryRequest};
    use uuid::Uuid;

    #[test]
    fn install_projection_requires_release_and_artifact_pair() {
        let request = UpdateLibraryEntryRequest {
            status: LibraryEntryStatus::Listed,
            favorite: true,
            installed_release_id: Some(Uuid::new_v4()),
            installed_artifact_id: None,
        };
        assert!(!request.validate());
    }
}
