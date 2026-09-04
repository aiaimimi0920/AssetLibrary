use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use uuid::Uuid;

use crate::{
    PackageKind, PackageVisibility, PrincipalRef, PublicCompatibility, PublisherSummary,
    SCHEMA_VERSION_V1, events::plausible_rfc3339,
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherRole {
    Owner,
    Maintainer,
    ReleaseManager,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherState {
    Pending,
    Active,
    Suspended,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherMembership {
    pub publisher: PublisherSummary,
    pub publisher_status: PublisherState,
    pub role: PublisherRole,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherMembershipPage {
    pub schema_version: String,
    pub items: Vec<PublisherMembership>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnedPackageStatus {
    Draft,
    Submitted,
    Published,
    Suspended,
    Deprecated,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedPackage {
    pub id: Uuid,
    pub publisher_id: Uuid,
    pub slug: String,
    pub kind: PackageKind,
    pub status: OwnedPackageStatus,
    pub visibility: PackageVisibility,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedPackageSummary {
    pub id: Uuid,
    pub publisher_id: Uuid,
    pub slug: String,
    pub kind: PackageKind,
    pub status: OwnedPackageStatus,
    pub visibility: PackageVisibility,
    pub name: String,
    pub summary: String,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedPackagePage {
    pub schema_version: String,
    pub items: Vec<OwnedPackageSummary>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreatePackageRequest {
    pub slug: String,
    pub kind: PackageKind,
    pub visibility: PackageVisibility,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdatePackageRequest {
    pub expected_updated_at: String,
    pub visibility: PackageVisibility,
    pub name: String,
    pub summary: String,
    pub description: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum OwnedReleaseStatus {
    Draft,
    Uploading,
    Submitted,
    InReview,
    Approved,
    Published,
    Rejected,
    Yanked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedRelease {
    pub id: Uuid,
    pub package_id: Uuid,
    pub version: String,
    pub status: OwnedReleaseStatus,
    pub compatibility: PublicCompatibility,
    pub permissions: Vec<String>,
    pub created_by: PrincipalRef,
    pub published_at: Option<String>,
    pub yanked_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OwnedReleasePage {
    pub schema_version: String,
    pub items: Vec<OwnedRelease>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateReleaseRequest {
    pub version: String,
    pub compatibility: PublicCompatibility,
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UpdateReleaseRequest {
    pub expected_updated_at: String,
    pub compatibility: PublicCompatibility,
    pub permissions: Vec<String>,
}

impl PublisherMembership {
    pub fn validate(&self) -> bool {
        !self.publisher.id.is_nil()
            && valid_slug(&self.publisher.slug)
            && bounded_line(&self.publisher.display_name, 160, false)
    }
}

impl PublisherMembershipPage {
    pub fn validate(&self) -> bool {
        valid_page(
            &self.schema_version,
            self.items.len(),
            self.next_cursor.as_deref(),
        ) && self.items.iter().all(PublisherMembership::validate)
    }
}

impl CreatePackageRequest {
    pub fn validate(&self) -> bool {
        valid_package_fields(&self.slug, &self.name, &self.summary, &self.tags)
            && bounded_multiline(&self.description, 100_000)
    }
}

impl UpdatePackageRequest {
    pub fn validate(&self) -> bool {
        plausible_rfc3339(&self.expected_updated_at)
            && valid_editable_package_fields(&self.name, &self.summary, &self.tags)
            && bounded_multiline(&self.description, 100_000)
    }
}

impl OwnedPackage {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.publisher_id.is_nil()
            && valid_package_fields(&self.slug, &self.name, &self.summary, &self.tags)
            && bounded_multiline(&self.description, 100_000)
            && plausible_rfc3339(&self.created_at)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl OwnedPackageSummary {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.publisher_id.is_nil()
            && valid_package_fields(&self.slug, &self.name, &self.summary, &self.tags)
            && plausible_rfc3339(&self.created_at)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl OwnedPackagePage {
    pub fn validate(&self) -> bool {
        valid_page(
            &self.schema_version,
            self.items.len(),
            self.next_cursor.as_deref(),
        ) && self.items.iter().all(OwnedPackageSummary::validate)
    }
}

impl CreateReleaseRequest {
    pub fn validate(&self) -> bool {
        valid_release_fields(&self.version, &self.compatibility, &self.permissions)
    }
}

impl UpdateReleaseRequest {
    pub fn validate(&self) -> bool {
        plausible_rfc3339(&self.expected_updated_at)
            && valid_editable_release_fields(&self.compatibility, &self.permissions)
    }
}

impl OwnedRelease {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.package_id.is_nil()
            && valid_release_fields(&self.version, &self.compatibility, &self.permissions)
            && bounded_line(&self.created_by.issuer, 200, false)
            && bounded_line(&self.created_by.subject, 200, false)
            && self.published_at.as_deref().is_none_or(plausible_rfc3339)
            && self.yanked_at.as_deref().is_none_or(plausible_rfc3339)
            && plausible_rfc3339(&self.created_at)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl OwnedReleasePage {
    pub fn validate(&self) -> bool {
        valid_page(
            &self.schema_version,
            self.items.len(),
            self.next_cursor.as_deref(),
        ) && self.items.iter().all(OwnedRelease::validate)
    }
}

fn valid_page(schema: &str, length: usize, cursor: Option<&str>) -> bool {
    schema == SCHEMA_VERSION_V1 && length <= 100 && cursor.is_none_or(|value| value.len() <= 256)
}

fn valid_package_fields(slug: &str, name: &str, summary: &str, tags: &[String]) -> bool {
    valid_slug(slug) && valid_editable_package_fields(name, summary, tags)
}

fn valid_editable_package_fields(name: &str, summary: &str, tags: &[String]) -> bool {
    let mut unique = BTreeSet::new();
    bounded_line(name, 160, false)
        && bounded_line(summary, 1000, true)
        && tags.len() <= 32
        && tags.iter().all(|tag| unique.insert(tag) && valid_tag(tag))
}

fn valid_release_fields(
    version: &str,
    compatibility: &PublicCompatibility,
    permissions: &[String],
) -> bool {
    semver::Version::parse(version).is_ok()
        && version.len() <= 100
        && valid_editable_release_fields(compatibility, permissions)
}

fn valid_editable_release_fields(
    compatibility: &PublicCompatibility,
    permissions: &[String],
) -> bool {
    let mut unique = BTreeSet::new();
    compatibility.validate()
        && permissions.len() <= 64
        && permissions
            .iter()
            .all(|permission| unique.insert(permission) && bounded_line(permission, 160, false))
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

fn valid_tag(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn bounded_line(value: &str, maximum: usize, empty_allowed: bool) -> bool {
    (empty_allowed || !value.is_empty())
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn bounded_multiline(value: &str, maximum: usize) -> bool {
    value.chars().count() <= maximum
        && value.trim() == value
        && !value
            .chars()
            .any(|value| value.is_control() && !matches!(value, '\n' | '\r' | '\t'))
}

#[cfg(test)]
mod tests {
    use super::{
        OwnedPackagePage, OwnedReleasePage, PublisherMembershipPage, UpdatePackageRequest,
        UpdateReleaseRequest,
    };

    #[test]
    fn publisher_console_fixtures_match_rust_contracts() {
        let memberships: PublisherMembershipPage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/publisher-membership-page.v1.json"
        ))
        .expect("publisher membership fixture must deserialize");
        let packages: OwnedPackagePage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/owned-package-page.v1.json"
        ))
        .expect("owned package fixture must deserialize");
        let releases: OwnedReleasePage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/owned-release-page.v1.json"
        ))
        .expect("owned release fixture must deserialize");

        assert!(memberships.validate());
        assert!(packages.validate());
        assert!(releases.validate());
    }

    #[test]
    fn release_update_requires_a_full_concurrency_timestamp() {
        let mut value = serde_json::json!({
            "expected_updated_at": "2026-09-03T08:00:00Z",
            "compatibility": {"products": []},
            "permissions": ["filesystem.read-project"]
        });
        let request: UpdateReleaseRequest =
            serde_json::from_value(value.clone()).expect("valid update must deserialize");
        assert!(request.validate());

        value["expected_updated_at"] = serde_json::json!("2026-09-03");
        let invalid: UpdateReleaseRequest =
            serde_json::from_value(value).expect("shape remains deserializable");
        assert!(!invalid.validate());
    }

    #[test]
    fn package_update_rejects_unknown_or_invalid_editable_fields() {
        let value = serde_json::json!({
            "expected_updated_at": "2026-09-03T08:00:00Z",
            "visibility": "unlisted",
            "name": "Updated package",
            "summary": "Updated summary",
            "description": "Updated description",
            "tags": ["art", "updated"]
        });
        let request: UpdatePackageRequest =
            serde_json::from_value(value.clone()).expect("valid update must deserialize");
        assert!(request.validate());

        let mut duplicate_tags = value.clone();
        duplicate_tags["tags"] = serde_json::json!(["art", "art"]);
        let invalid: UpdatePackageRequest = serde_json::from_value(duplicate_tags)
            .expect("invalid values still have the request shape");
        assert!(!invalid.validate());

        let mut immutable_slug = value;
        immutable_slug["slug"] = serde_json::json!("cannot-change");
        assert!(serde_json::from_value::<UpdatePackageRequest>(immutable_slug).is_err());
    }
}
