use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    ArtifactStatus, MAX_ARTIFACT_SIZE, ReviewDecision, ReviewFinding, SCHEMA_VERSION_V1,
    SubmissionStatus, events::plausible_rfc3339,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherArtifactSummary {
    pub id: Uuid,
    pub status: ArtifactStatus,
    pub file_name: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub expected_digest: Option<String>,
    pub verified_digest: Option<String>,
    pub scanner_version: Option<String>,
    pub rule_version: Option<String>,
    pub verified_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherSubmissionSummary {
    pub id: Uuid,
    pub artifact_id: Uuid,
    pub revision: u32,
    pub status: SubmissionStatus,
    pub required_approvals: u8,
    pub approval_count: u8,
    pub submitted_at: Option<String>,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherReviewFeedback {
    pub revision: u32,
    pub decision: ReviewDecision,
    pub reason: String,
    pub findings: Vec<ReviewFinding>,
    pub decided_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherReleaseWorkspace {
    pub schema_version: String,
    pub release_id: Uuid,
    pub artifacts: Vec<PublisherArtifactSummary>,
    pub artifacts_truncated: bool,
    pub submission: Option<PublisherSubmissionSummary>,
    pub feedback: Vec<PublisherReviewFeedback>,
    pub feedback_truncated: bool,
    pub can_upload: bool,
}

impl PublisherArtifactSummary {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && valid_file_name(&self.file_name)
            && (1..=MAX_ARTIFACT_SIZE).contains(&self.size_bytes)
            && bounded_line(&self.media_type, 1, 200)
            && self.expected_digest.as_deref().is_none_or(valid_digest)
            && self.verified_digest.as_deref().is_none_or(valid_digest)
            && self
                .scanner_version
                .as_deref()
                .is_none_or(|value| bounded_line(value, 1, 100))
            && self
                .rule_version
                .as_deref()
                .is_none_or(|value| bounded_line(value, 1, 100))
            && self.verified_at.as_deref().is_none_or(plausible_rfc3339)
            && plausible_rfc3339(&self.created_at)
            && plausible_rfc3339(&self.updated_at)
            && (!matches!(self.status, ArtifactStatus::Verified)
                || (self.verified_digest.is_some()
                    && self.scanner_version.is_some()
                    && self.rule_version.is_some()
                    && self.verified_at.is_some()))
    }
}

impl PublisherSubmissionSummary {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.artifact_id.is_nil()
            && (1..=10_000).contains(&self.revision)
            && matches!(self.required_approvals, 1 | 2)
            && self.approval_count <= self.required_approvals
            && self.submitted_at.as_deref().is_none_or(plausible_rfc3339)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl PublisherReviewFeedback {
    fn validate(&self) -> bool {
        (1..=10_000).contains(&self.revision)
            && bounded_multiline(&self.reason, 0, 4_000)
            && self.findings.len() <= 100
            && self.findings.iter().all(|finding| {
                bounded_line(&finding.code, 1, 100) && bounded_multiline(&finding.message, 1, 2_000)
            })
            && plausible_rfc3339(&self.decided_at)
    }
}

impl PublisherReleaseWorkspace {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && !self.release_id.is_nil()
            && self.artifacts.len() <= 100
            && self.feedback.len() <= 100
            && self
                .artifacts
                .iter()
                .all(PublisherArtifactSummary::validate)
            && self
                .submission
                .as_ref()
                .is_none_or(PublisherSubmissionSummary::validate)
            && self.feedback.iter().all(PublisherReviewFeedback::validate)
    }
}

fn valid_file_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 240
        && !value.starts_with('.')
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
        && value.ends_with(".zip")
}

fn valid_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn bounded_line(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.chars().count())
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn bounded_multiline(value: &str, minimum: usize, maximum: usize) -> bool {
    (minimum..=maximum).contains(&value.chars().count())
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

#[cfg(test)]
mod tests {
    use crate::MAX_ARTIFACT_SIZE;

    use super::PublisherReleaseWorkspace;

    #[test]
    fn publisher_workspace_fixture_is_bounded_and_valid() {
        let workspace: PublisherReleaseWorkspace = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/publisher-release-workspace.v1.json"
        ))
        .expect("publisher workspace fixture must deserialize");
        assert!(workspace.validate());
    }

    #[test]
    fn publisher_workspace_rejects_artifacts_above_the_upload_limit() {
        let mut workspace: PublisherReleaseWorkspace = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/publisher-release-workspace.v1.json"
        ))
        .expect("publisher workspace fixture must deserialize");
        workspace.artifacts[0].size_bytes = MAX_ARTIFACT_SIZE + 1;
        assert!(!workspace.validate());
    }
}
