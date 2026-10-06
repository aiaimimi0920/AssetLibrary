use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppealResolution, ModerationActionKind, ModerationActionStatus, ModerationCaseStatus,
    ModerationTargetKind, OperatorReviewPackage, SCHEMA_VERSION_V1, events::plausible_rfc3339,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorModerationRelease {
    pub id: Uuid,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorModerationCaseItem {
    pub id: Uuid,
    pub status: ModerationCaseStatus,
    pub package: OperatorReviewPackage,
    pub release: Option<OperatorModerationRelease>,
    pub reason_preview: String,
    pub action_status: Option<ModerationActionStatus>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorModerationQueuePage {
    pub schema_version: String,
    pub items: Vec<OperatorModerationCaseItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorModerationActionRecord {
    pub id: Uuid,
    pub action: ModerationActionKind,
    pub target_type: ModerationTargetKind,
    pub target_ref: String,
    pub status: ModerationActionStatus,
    pub reason: String,
    pub created_at: String,
    pub applied_at: Option<String>,
    pub can_approve: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorModerationAppeal {
    pub reason: String,
    pub resolution: Option<AppealResolution>,
    pub resolution_reason: Option<String>,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct OperatorModerationCaseDetail {
    pub schema_version: String,
    pub item: OperatorModerationCaseItem,
    pub report_reason: String,
    pub evidence_urls: Vec<String>,
    pub actions: Vec<OperatorModerationActionRecord>,
    pub appeal: Option<OperatorModerationAppeal>,
    pub can_propose: bool,
    pub can_resolve: bool,
}

impl OperatorModerationCaseItem {
    pub fn validate(&self) -> bool {
        let action_matches = match self.status {
            ModerationCaseStatus::Open => {
                self.action_status != Some(ModerationActionStatus::Applied)
            }
            _ => self.action_status == Some(ModerationActionStatus::Applied),
        };
        !self.id.is_nil()
            && self.package.validate()
            && self
                .release
                .as_ref()
                .is_none_or(OperatorModerationRelease::validate)
            && bounded_multiline(&self.reason_preview, 240, false)
            && action_matches
            && plausible_rfc3339(&self.created_at)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl OperatorModerationRelease {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && self.version.len() <= 100
            && semver::Version::parse(&self.version).is_ok()
    }
}

impl OperatorModerationQueuePage {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.items.len() <= 100
            && self
                .next_cursor
                .as_deref()
                .is_none_or(|value| !value.is_empty() && value.len() <= 256)
            && self.items.iter().all(OperatorModerationCaseItem::validate)
    }
}

impl OperatorModerationActionRecord {
    fn validate(&self) -> bool {
        let timing_matches = match self.status {
            ModerationActionStatus::Proposed => self.applied_at.is_none(),
            ModerationActionStatus::Applied => {
                self.applied_at.as_deref().is_some_and(plausible_rfc3339) && !self.can_approve
            }
        };
        !self.id.is_nil()
            && valid_pair(self.action, self.target_type)
            && bounded_line(&self.target_ref, 200, false)
            && bounded_multiline(&self.reason, 4_000, false)
            && plausible_rfc3339(&self.created_at)
            && timing_matches
    }
}

impl OperatorModerationAppeal {
    fn validate(&self) -> bool {
        let resolved = self.resolution.is_some();
        bounded_multiline(&self.reason, 4_000, false)
            && (resolved
                == self
                    .resolution_reason
                    .as_deref()
                    .is_some_and(|value| bounded_multiline(value, 4_000, false)))
            && (resolved == self.resolved_at.as_deref().is_some_and(plausible_rfc3339))
    }
}

impl OperatorModerationCaseDetail {
    pub fn validate(&self) -> bool {
        let state_matches = match self.item.status {
            ModerationCaseStatus::Open => {
                self.appeal.is_none()
                    && !self.can_resolve
                    && (self.actions.is_empty() == self.can_propose)
            }
            ModerationCaseStatus::Actioned => {
                self.appeal.is_none() && !self.can_propose && !self.can_resolve
            }
            ModerationCaseStatus::Appealed => {
                self.appeal
                    .as_ref()
                    .is_some_and(|appeal| appeal.resolution.is_none())
                    && !self.can_propose
                    && self.can_resolve
            }
            ModerationCaseStatus::Resolved => {
                self.appeal
                    .as_ref()
                    .is_some_and(|appeal| appeal.resolution.is_some())
                    && !self.can_propose
                    && !self.can_resolve
            }
        };
        self.schema_version == SCHEMA_VERSION_V1
            && self.item.validate()
            && bounded_multiline(&self.report_reason, 4_000, false)
            && self.evidence_urls.len() <= 20
            && self
                .evidence_urls
                .iter()
                .all(|value| valid_evidence_url(value))
            && self.actions.len() <= 1
            && self
                .actions
                .iter()
                .all(OperatorModerationActionRecord::validate)
            && self
                .appeal
                .as_ref()
                .is_none_or(OperatorModerationAppeal::validate)
            && state_matches
    }
}

fn valid_pair(action: ModerationActionKind, target: ModerationTargetKind) -> bool {
    matches!(
        (action, target),
        (
            ModerationActionKind::Suspend,
            ModerationTargetKind::Publisher | ModerationTargetKind::Package
        ) | (ModerationActionKind::Yank, ModerationTargetKind::Release)
            | (
                ModerationActionKind::Revoke,
                ModerationTargetKind::Artifact | ModerationTargetKind::SigningKey
            )
            | (ModerationActionKind::Block, _)
    )
}

fn valid_evidence_url(value: &str) -> bool {
    bounded_line(value, 2_000, false) && value.starts_with("https://")
}

fn bounded_line(value: &str, maximum: usize, empty: bool) -> bool {
    (empty || !value.is_empty())
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn bounded_multiline(value: &str, maximum: usize, empty: bool) -> bool {
    (empty || !value.is_empty())
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

#[cfg(test)]
mod tests {
    use super::{OperatorModerationCaseDetail, OperatorModerationQueuePage};

    #[test]
    fn operator_moderation_fixtures_match_contracts() {
        let queue: OperatorModerationQueuePage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/operator-moderation-queue-page.v1.json"
        ))
        .expect("operator moderation queue fixture must deserialize");
        let detail: OperatorModerationCaseDetail = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/operator-moderation-case-detail.v1.json"
        ))
        .expect("operator moderation detail fixture must deserialize");
        assert!(queue.validate());
        assert!(detail.validate());
    }
}
