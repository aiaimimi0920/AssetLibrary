use serde::{Deserialize, Serialize};
use uuid::Uuid;

mod artifact;
pub use artifact::*;
mod events;
pub use events::*;
mod download;
pub use download::*;
mod library;
pub use library::*;
mod install_receipt;
pub use install_receipt::*;
mod moderation;
pub use moderation::*;
mod operator_review;
pub use operator_review::*;
mod operator_moderation;
pub use operator_moderation::*;
mod publisher;
pub use publisher::*;
mod publisher_signing_key;
pub use publisher_signing_key::*;
mod publisher_moderation;
pub use publisher_moderation::*;
mod publisher_workspace;
pub use publisher_workspace::*;
mod publisher_events;
pub use publisher_events::*;
mod public_catalog;
pub use public_catalog::*;
mod review;
pub use review::*;
mod sitemap;
pub use sitemap::*;
mod search;
pub use search::*;
mod workflow_events;
pub use workflow_events::*;

pub const SCHEMA_VERSION_V1: &str = "1.0";

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PrincipalRef {
    pub issuer: String,
    pub subject: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherSummary {
    pub id: Uuid,
    pub slug: String,
    pub display_name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageKind {
    Art,
    Capability,
    AppUpdate,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageStatus {
    Published,
    Suspended,
    Archived,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PackageVisibility {
    Public,
    Unlisted,
    Private,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublishedPackage {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub kind: PackageKind,
    pub publisher: PublisherSummary,
    pub status: PackageStatus,
    pub summary: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackagePage {
    pub schema_version: String,
    pub items: Vec<PublishedPackage>,
    pub next_cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::{PackageKind, PackagePage, PackageStatus, SCHEMA_VERSION_V1};

    #[test]
    fn shared_package_fixture_matches_rust_contract() {
        let fixture = include_str!("../../../contracts/fixtures/package-page.v1.json");
        let page: PackagePage = serde_json::from_str(fixture).expect("fixture must deserialize");

        assert_eq!(page.schema_version, SCHEMA_VERSION_V1);
        assert_eq!(page.items.len(), 1);
        assert_eq!(page.items[0].kind, PackageKind::Art);
        assert_eq!(page.items[0].status, PackageStatus::Published);
    }
}
