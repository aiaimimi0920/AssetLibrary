use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    AppealResolution, ModerationActionKind, ModerationActionStatus, ModerationCaseStatus,
    ModerationTargetKind, PackageKind, SCHEMA_VERSION_V1, events::plausible_rfc3339,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationPackage {
    pub id: Uuid,
    pub publisher_id: Uuid,
    pub slug: String,
    pub name: String,
    pub kind: PackageKind,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationRelease {
    pub id: Uuid,
    pub version: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationAction {
    pub id: Uuid,
    pub action: ModerationActionKind,
    pub target_type: ModerationTargetKind,
    pub target_ref: String,
    pub status: ModerationActionStatus,
    pub reason_preview: String,
    pub applied_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationCaseItem {
    pub id: Uuid,
    pub status: ModerationCaseStatus,
    pub package: PublisherModerationPackage,
    pub release: Option<PublisherModerationRelease>,
    pub action: PublisherModerationAction,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationCasePage {
    pub schema_version: String,
    pub items: Vec<PublisherModerationCaseItem>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationAppeal {
    pub reason: String,
    pub resolution: Option<AppealResolution>,
    pub resolution_reason: Option<String>,
    pub resolved_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherModerationCaseDetail {
    pub schema_version: String,
    pub item: PublisherModerationCaseItem,
    pub action_reason: String,
    pub appeal: Option<PublisherModerationAppeal>,
    pub can_appeal: bool,
}

impl PublisherModerationPackage {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && !self.publisher_id.is_nil()
            && valid_slug(&self.slug)
            && bounded_line(&self.name, 160)
    }
}

impl PublisherModerationRelease {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && self.version.len() <= 100
            && semver::Version::parse(&self.version).is_ok()
    }
}

impl PublisherModerationAction {
    fn validate(&self) -> bool {
        !self.id.is_nil()
            && self.status == ModerationActionStatus::Applied
            && valid_pair(self.action, self.target_type)
            && bounded_line(&self.target_ref, 200)
            && bounded_multiline(&self.reason_preview, 240)
            && plausible_rfc3339(&self.applied_at)
    }
}

impl PublisherModerationCaseItem {
    pub fn validate(&self) -> bool {
        !self.id.is_nil()
            && matches!(
                self.status,
                ModerationCaseStatus::Actioned
                    | ModerationCaseStatus::Appealed
                    | ModerationCaseStatus::Resolved
            )
            && self.package.validate()
            && self
                .release
                .as_ref()
                .is_none_or(PublisherModerationRelease::validate)
            && self.action.validate()
            && plausible_rfc3339(&self.created_at)
            && plausible_rfc3339(&self.updated_at)
    }
}

impl PublisherModerationCasePage {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.items.len() <= 100
            && self
                .next_cursor
                .as_deref()
                .is_none_or(|value| !value.is_empty() && value.len() <= 256)
            && self.items.iter().all(PublisherModerationCaseItem::validate)
    }
}

impl PublisherModerationAppeal {
    fn validate(&self) -> bool {
        let resolved = self.resolution.is_some();
        bounded_multiline(&self.reason, 4_000)
            && (resolved
                == self
                    .resolution_reason
                    .as_deref()
                    .is_some_and(|value| bounded_multiline(value, 4_000)))
            && (resolved == self.resolved_at.as_deref().is_some_and(plausible_rfc3339))
    }
}

impl PublisherModerationCaseDetail {
    pub fn validate(&self) -> bool {
        let state_matches = match self.item.status {
            ModerationCaseStatus::Actioned => self.appeal.is_none() && self.can_appeal,
            ModerationCaseStatus::Appealed => {
                self.appeal
                    .as_ref()
                    .is_some_and(|appeal| appeal.resolution.is_none())
                    && !self.can_appeal
            }
            ModerationCaseStatus::Resolved => {
                self.appeal
                    .as_ref()
                    .is_some_and(|appeal| appeal.resolution.is_some())
                    && !self.can_appeal
            }
            ModerationCaseStatus::Open => false,
        };
        self.schema_version == SCHEMA_VERSION_V1
            && self.item.validate()
            && bounded_multiline(&self.action_reason, 4_000)
            && self
                .appeal
                .as_ref()
                .is_none_or(PublisherModerationAppeal::validate)
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

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

fn bounded_line(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn bounded_multiline(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value
            .chars()
            .any(|character| character.is_control() && !matches!(character, '\n' | '\r' | '\t'))
}

#[cfg(test)]
mod tests {
    use super::{PublisherModerationCaseDetail, PublisherModerationCasePage};

    #[test]
    fn publisher_moderation_fixtures_match_contracts() {
        let page: PublisherModerationCasePage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/publisher-moderation-case-page.v1.json"
        ))
        .expect("publisher moderation page fixture must deserialize");
        let detail: PublisherModerationCaseDetail = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/publisher-moderation-case-detail.v1.json"
        ))
        .expect("publisher moderation detail fixture must deserialize");
        assert!(page.validate());
        assert!(detail.validate());
    }
}
