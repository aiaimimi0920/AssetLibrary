use serde::{Deserialize, Serialize};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationCaseStatus {
    Open,
    Actioned,
    Appealed,
    Resolved,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationActionKind {
    Suspend,
    Yank,
    Revoke,
    Block,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationTargetKind {
    Publisher,
    Package,
    Release,
    Artifact,
    SigningKey,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ModerationActionStatus {
    Proposed,
    Applied,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum AppealResolution {
    Upheld,
    BlockLifted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReportPackageRequest {
    pub release_id: Option<Uuid>,
    pub reason: String,
    pub evidence_urls: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ProposeModerationActionRequest {
    pub action: ModerationActionKind,
    pub target_type: ModerationTargetKind,
    pub target_ref: String,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppealModerationRequest {
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ResolveModerationRequest {
    pub resolution: AppealResolution,
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModerationCaseView {
    pub id: Uuid,
    pub package_id: Uuid,
    pub release_id: Option<Uuid>,
    pub status: ModerationCaseStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ModerationActionView {
    pub id: Uuid,
    pub case_id: Uuid,
    pub action: ModerationActionKind,
    pub target_type: ModerationTargetKind,
    pub target_ref: String,
    pub status: ModerationActionStatus,
}

impl ReportPackageRequest {
    pub fn validate(&self) -> bool {
        bounded_multiline(&self.reason, 1, 4_000)
            && self.evidence_urls.len() <= 20
            && self
                .evidence_urls
                .iter()
                .all(|value| bounded_line(value, 1, 2_000) && value.starts_with("https://"))
    }
}

impl ProposeModerationActionRequest {
    pub fn validate(&self) -> bool {
        bounded_line(&self.target_ref, 1, 200)
            && bounded_multiline(&self.reason, 1, 4_000)
            && valid_pair(self.action, self.target_type)
    }
}

impl AppealModerationRequest {
    pub fn validate(&self) -> bool {
        bounded_multiline(&self.reason, 1, 4_000)
    }
}

impl ResolveModerationRequest {
    pub fn validate(&self) -> bool {
        bounded_multiline(&self.reason, 1, 4_000)
    }
}

fn valid_pair(action: ModerationActionKind, target: ModerationTargetKind) -> bool {
    matches!(
        (action, target),
        (
            ModerationActionKind::Suspend,
            ModerationTargetKind::Publisher
        ) | (ModerationActionKind::Suspend, ModerationTargetKind::Package)
            | (ModerationActionKind::Yank, ModerationTargetKind::Release)
            | (ModerationActionKind::Revoke, ModerationTargetKind::Artifact)
            | (
                ModerationActionKind::Revoke,
                ModerationTargetKind::SigningKey
            )
            | (ModerationActionKind::Block, _)
    )
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
    use super::{
        AppealModerationRequest, ModerationActionKind, ModerationTargetKind,
        ProposeModerationActionRequest,
    };

    #[test]
    fn rejects_action_target_mismatch() {
        let request = ProposeModerationActionRequest {
            action: ModerationActionKind::Yank,
            target_type: ModerationTargetKind::Publisher,
            target_ref: uuid::Uuid::new_v4().to_string(),
            reason: "Policy violation".to_owned(),
        };
        assert!(!request.validate());
    }

    #[test]
    fn rejects_control_characters_and_untrimmed_reasons() {
        assert!(
            !AppealModerationRequest {
                reason: " padded ".to_owned()
            }
            .validate()
        );
        assert!(
            !AppealModerationRequest {
                reason: "bad\u{0}reason".to_owned()
            }
            .validate()
        );
        assert!(
            AppealModerationRequest {
                reason: "line one\nline two".to_owned()
            }
            .validate()
        );
    }
}
