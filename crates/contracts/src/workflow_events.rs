use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    DownloadClientType, EventActor, ModerationActionKind, ModerationTargetKind, SCHEMA_VERSION_V1,
    events::{bounded_nonempty, plausible_rfc3339},
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleasePublished {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub release_id: Uuid,
    pub package_id: Uuid,
    pub artifact_id: Uuid,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum CatalogInvalidationReason {
    ReleasePublished,
    ModerationAction,
    BlockLifted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CatalogInvalidated {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub package_id: Uuid,
    pub reason: CatalogInvalidationReason,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PolicyChanged {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub case_id: Uuid,
    pub action_id: Option<Uuid>,
    pub action: Option<ModerationActionKind>,
    pub target_type: Option<ModerationTargetKind>,
    pub target_ref: Option<String>,
    pub resolution: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DownloadAuthorized {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub session_id: Uuid,
    pub package_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub digest: String,
    pub client_type: DownloadClientType,
}

impl ReleasePublished {
    pub fn validate(&self) -> bool {
        valid_control(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
        ) && !self.release_id.is_nil()
            && !self.package_id.is_nil()
            && !self.artifact_id.is_nil()
    }
}

impl CatalogInvalidated {
    pub fn validate(&self) -> bool {
        valid_control(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
        ) && !self.package_id.is_nil()
    }
}

impl PolicyChanged {
    pub fn validate(&self) -> bool {
        if !valid_control(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
        ) || self.case_id.is_nil()
        {
            return false;
        }
        let action = self.action_id.is_some()
            && self.action.is_some()
            && self.target_type.is_some()
            && self
                .target_ref
                .as_deref()
                .is_some_and(|value| bounded_nonempty(value, 200))
            && self.resolution.is_none();
        let resolution = self.action_id.is_none()
            && self.action.is_none()
            && self.target_type.is_none()
            && self.target_ref.is_none()
            && matches!(self.resolution.as_deref(), Some("upheld" | "block_lifted"));
        action || resolution
    }
}

impl DownloadAuthorized {
    pub fn validate(&self) -> bool {
        valid_control(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
        ) && !self.session_id.is_nil()
            && !self.package_id.is_nil()
            && !self.release_id.is_nil()
            && !self.artifact_id.is_nil()
            && self.digest.len() == 71
            && self.digest.starts_with("sha256:")
            && self.digest[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    }
}

fn valid_control(id: Uuid, occurred_at: &str, schema: &str, actor: &EventActor) -> bool {
    !id.is_nil()
        && schema == SCHEMA_VERSION_V1
        && plausible_rfc3339(occurred_at)
        && actor.is_valid()
}

#[cfg(test)]
mod tests {
    use super::{PolicyChanged, ReleasePublished};
    use crate::{EventActor, ModerationActionKind, ModerationTargetKind};
    use uuid::Uuid;

    fn actor() -> EventActor {
        EventActor::System {
            id: "assetlibrary-control-plane".to_owned(),
        }
    }

    #[test]
    fn validates_release_publication_envelope() {
        let event = ReleasePublished {
            event_id: Uuid::new_v4(),
            occurred_at: "2026-09-03T08:00:00Z".to_owned(),
            schema_version: "1.0".to_owned(),
            actor: actor(),
            release_id: Uuid::new_v4(),
            package_id: Uuid::new_v4(),
            artifact_id: Uuid::new_v4(),
        };
        assert!(event.validate());
    }

    #[test]
    fn policy_event_requires_one_complete_variant() {
        let mut event = PolicyChanged {
            event_id: Uuid::new_v4(),
            occurred_at: "2026-09-03T08:00:00Z".to_owned(),
            schema_version: "1.0".to_owned(),
            actor: actor(),
            case_id: Uuid::new_v4(),
            action_id: Some(Uuid::new_v4()),
            action: Some(ModerationActionKind::Yank),
            target_type: Some(ModerationTargetKind::Release),
            target_ref: Some(Uuid::new_v4().to_string()),
            resolution: None,
        };
        assert!(event.validate());
        event.target_ref = None;
        assert!(!event.validate());
    }
}
