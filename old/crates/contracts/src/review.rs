use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SubmissionStatus {
    InReview,
    ChangesRequested,
    Approved,
    Rejected,
    Withdrawn,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateSubmissionRequest {
    pub artifact_id: Uuid,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WithdrawSubmissionRequest {
    pub reason: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ReviewDecision {
    Approved,
    Rejected,
    NeedsChanges,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum FindingSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewFinding {
    pub code: String,
    pub severity: FindingSeverity,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DecideReviewRequest {
    pub decision: ReviewDecision,
    pub reason: String,
    pub findings: Vec<ReviewFinding>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SubmissionView {
    pub id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub revision: u32,
    pub status: SubmissionStatus,
    pub required_approvals: u8,
    pub approval_count: u8,
    pub scanner_version: String,
    pub rule_version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReviewDecisionView {
    pub review_id: Uuid,
    pub submission: SubmissionView,
}

impl SubmissionView {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.release_id.is_nil()
            && !self.artifact_id.is_nil()
            && (1..=10_000).contains(&self.revision)
            && matches!(self.required_approvals, 1 | 2)
            && self.approval_count <= self.required_approvals
            && bounded_line(&self.scanner_version, 1, 100)
            && bounded_line(&self.rule_version, 1, 100)
    }
}

impl WithdrawSubmissionRequest {
    pub fn validate(&self) -> bool {
        bounded_multiline(&self.reason, 1, 2_000)
    }
}

impl DecideReviewRequest {
    pub fn validate(&self) -> bool {
        bounded_multiline(&self.reason, 1, 4_000)
            && self.findings.len() <= 100
            && self.findings.iter().all(|finding| {
                bounded_line(&finding.code, 1, 100) && bounded_multiline(&finding.message, 1, 2_000)
            })
    }
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
    use super::{DecideReviewRequest, FindingSeverity, ReviewDecision, ReviewFinding};

    #[test]
    fn review_input_is_bounded() {
        let mut request = DecideReviewRequest {
            decision: ReviewDecision::NeedsChanges,
            reason: "Update the manifest".to_owned(),
            findings: vec![ReviewFinding {
                code: "manifest.permission".to_owned(),
                severity: FindingSeverity::Error,
                message: "Permission is not declared".to_owned(),
            }],
        };
        assert!(request.validate());
        request.findings[0].code = "x".repeat(101);
        assert!(!request.validate());
    }
}
