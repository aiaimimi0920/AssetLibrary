use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

use crate::{DownloadArtifact, PublisherSummary, SCHEMA_VERSION_V1, events::plausible_rfc3339};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherProfile {
    pub schema_version: String,
    pub publisher: PublisherSummary,
}

impl PublisherProfile {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && !self.publisher.id.is_nil()
            && valid_slug(&self.publisher.slug)
            && bounded_text(&self.publisher.display_name, 160)
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HostProduct {
    Loom,
    Hook,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProductCompatibility {
    pub name: HostProduct,
    pub version_requirement: String,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublicCompatibility {
    pub products: Vec<ProductCompatibility>,
}

impl PublicCompatibility {
    pub fn validate(&self) -> bool {
        let mut products = BTreeSet::new();
        self.products.len() <= 8
            && self.products.iter().all(|product| {
                products.insert(product.name) && bounded_text(&product.version_requirement, 100)
            })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedReleaseArtifact {
    #[serde(flatten)]
    pub artifact: DownloadArtifact,
    pub signing_key_id: String,
}

impl PublishedReleaseArtifact {
    pub fn validate(&self) -> bool {
        self.artifact.validate() && bounded_text(&self.signing_key_id, 160)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedRelease {
    pub id: Uuid,
    pub version: String,
    pub published_at: String,
    pub compatibility: PublicCompatibility,
    pub permissions: Vec<String>,
    pub artifacts: Vec<PublishedReleaseArtifact>,
}

impl PublishedRelease {
    pub fn validate(&self) -> bool {
        let mut permissions = BTreeSet::new();
        !self.id.is_nil()
            && bounded_text(&self.version, 100)
            && plausible_rfc3339(&self.published_at)
            && self.compatibility.validate()
            && self.permissions.len() <= 64
            && self
                .permissions
                .iter()
                .all(|permission| permissions.insert(permission) && bounded_text(permission, 160))
            && !self.artifacts.is_empty()
            && self.artifacts.len() <= 32
            && self
                .artifacts
                .iter()
                .all(|artifact| artifact.artifact.release_id == self.id && artifact.validate())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedReleasePage {
    pub schema_version: String,
    pub items: Vec<PublishedRelease>,
    pub next_cursor: Option<String>,
}

impl PublishedReleasePage {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.items.len() <= 100
            && self.items.iter().all(PublishedRelease::validate)
            && self
                .next_cursor
                .as_ref()
                .is_none_or(|cursor| cursor.len() <= 256)
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

fn bounded_text(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::PublishedReleasePage;

    #[test]
    fn shared_release_fixture_matches_rust_contract() {
        let fixture = include_str!("../../../contracts/fixtures/published-release-page.v1.json");
        let page: PublishedReleasePage =
            serde_json::from_str(fixture).expect("fixture must deserialize");

        assert!(page.validate());
        assert_eq!(page.items[0].version, "1.2.0");
    }
}
