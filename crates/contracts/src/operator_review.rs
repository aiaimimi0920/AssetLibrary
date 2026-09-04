use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    PackageKind, PublicCompatibility, PublisherSummary, ReviewDecision, ReviewFinding,
    SCHEMA_VERSION_V1, SubmissionView, events::plausible_rfc3339,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorReviewPackage {
    pub id: Uuid,
    pub slug: String,
    pub name: String,
    pub kind: PackageKind,
    pub summary: String,
    pub publisher: PublisherSummary,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorReviewQueueItem {
    pub submission: SubmissionView,
    pub package: OperatorReviewPackage,
    pub release_version: String,
    pub submitted_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorReviewQueuePage {
    pub schema_version: String,
    pub items: Vec<OperatorReviewQueueItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorArtifactEvidence {
    pub digest: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub policy_version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorReviewRecord {
    pub id: Uuid,
    pub revision: u32,
    pub decision: ReviewDecision,
    pub reason: String,
    pub findings: Vec<ReviewFinding>,
    pub decided_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorSubmissionDetail {
    pub schema_version: String,
    pub item: OperatorReviewQueueItem,
    pub compatibility: PublicCompatibility,
    pub permissions: Vec<String>,
    pub evidence: OperatorArtifactEvidence,
    pub reviews: Vec<OperatorReviewRecord>,
    pub can_review: bool,
}

impl OperatorReviewPackage {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && valid_slug(&self.slug)
            && bounded_line(&self.name, 160, false)
            && bounded_line(&self.summary, 1_000, true)
            && !self.publisher.id.is_nil()
            && valid_slug(&self.publisher.slug)
            && bounded_line(&self.publisher.display_name, 160, false)
    }
}

impl OperatorReviewQueueItem {
    pub fn validate(&self) -> bool {
        self.submission.validate()
            && self.package.validate()
            && semver::Version::parse(&self.release_version).is_ok()
            && self.release_version.len() <= 100
            && plausible_rfc3339(&self.submitted_at)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl OperatorReviewQueuePage {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.items.len() <= 100
            && self
                .next_cursor
                .as_deref()
                .is_none_or(|cursor| !cursor.is_empty() && cursor.len() <= 256)
            && self.items.iter().all(OperatorReviewQueueItem::validate)
    }
}

impl OperatorSubmissionDetail {
    pub fn validate(&self) -> bool {
        let mut permissions = std::collections::BTreeSet::new();
        self.schema_version == SCHEMA_VERSION_V1
            && self.item.validate()
            && self.compatibility.validate()
            && self.permissions.len() <= 64
            && self.permissions.iter().all(|permission| {
                permissions.insert(permission) && bounded_line(permission, 160, false)
            })
            && self.evidence.validate()
            && self.reviews.len() <= 100
            && self.reviews.iter().all(OperatorReviewRecord::validate)
    }
}

impl OperatorArtifactEvidence {
    fn validate(&self) -> bool {
        self.digest.len() == 71
            && self.digest.starts_with("sha256:")
            && self.digest[7..]
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            && (1..=10_737_418_240).contains(&self.size_bytes)
            && bounded_line(&self.media_type, 200, false)
            && bounded_line(&self.policy_version, 100, false)
    }
}

impl OperatorReviewRecord {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && (1..=10_000).contains(&self.revision)
            && bounded_multiline(&self.reason, 4_000, true)
            && self.findings.len() <= 100
            && self.findings.iter().all(|finding| {
                bounded_line(&finding.code, 100, false)
                    && bounded_multiline(&finding.message, 2_000, false)
            })
            && plausible_rfc3339(&self.decided_at)
    }
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

fn bounded_line(value: &str, maximum: usize, empty_allowed: bool) -> bool {
    (empty_allowed || !value.is_empty())
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn bounded_multiline(value: &str, maximum: usize, empty_allowed: bool) -> bool {
    (empty_allowed || !value.is_empty())
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

#[cfg(test)]
mod tests {
    use super::{OperatorReviewQueuePage, OperatorSubmissionDetail};

    #[test]
    fn operator_review_fixtures_match_contracts() {
        let queue: OperatorReviewQueuePage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/operator-review-queue-page.v1.json"
        ))
        .expect("operator queue fixture must deserialize");
        let detail: OperatorSubmissionDetail = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/operator-submission-detail.v1.json"
        ))
        .expect("operator detail fixture must deserialize");
        assert!(queue.validate());
        assert!(detail.validate());
    }
}
