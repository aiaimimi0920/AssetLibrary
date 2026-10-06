use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::SCHEMA_VERSION_V1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
pub enum EventActor {
    Principal { issuer: String, subject: String },
    System { id: String },
}

impl EventActor {
    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Principal { issuer, subject } => {
                bounded_nonempty(issuer, 200) && bounded_nonempty(subject, 200)
            }
            Self::System { id } => bounded_nonempty(id, 100),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationRequested {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub package_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub object_key: String,
    pub digest: String,
}

impl VerificationRequested {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && plausible_rfc3339(&self.occurred_at)
            && self.actor.is_valid()
            && !self.event_id.is_nil()
            && !self.package_id.is_nil()
            && !self.release_id.is_nil()
            && !self.artifact_id.is_nil()
            && bounded_nonempty(&self.object_key, 1024)
            && valid_sha256(&self.digest)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ArtifactResult {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub package_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub source_event_id: Uuid,
    pub failure_code: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerificationDeadLetter {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub package_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub source_event_id: Uuid,
    pub object_key: String,
    pub digest: String,
    pub failure_code: String,
    pub delivery_count: u32,
}

impl ArtifactResult {
    pub fn validate(&self) -> bool {
        valid_artifact_envelope(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
            self.package_id,
            self.release_id,
            self.artifact_id,
        ) && !self.source_event_id.is_nil()
            && self
                .failure_code
                .as_deref()
                .is_none_or(|value| bounded_nonempty(value, 100))
    }
}

impl VerificationDeadLetter {
    pub fn validate(&self) -> bool {
        valid_artifact_envelope(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
            self.package_id,
            self.release_id,
            self.artifact_id,
        ) && !self.source_event_id.is_nil()
            && bounded_nonempty(&self.object_key, 1024)
            && valid_sha256(&self.digest)
            && bounded_nonempty(&self.failure_code, 100)
            && self.delivery_count > 0
    }
}

fn valid_artifact_envelope(
    event_id: Uuid,
    occurred_at: &str,
    schema_version: &str,
    actor: &EventActor,
    package_id: Uuid,
    release_id: Uuid,
    artifact_id: Uuid,
) -> bool {
    schema_version == SCHEMA_VERSION_V1
        && plausible_rfc3339(occurred_at)
        && actor.is_valid()
        && !event_id.is_nil()
        && !package_id.is_nil()
        && !release_id.is_nil()
        && !artifact_id.is_nil()
}

pub(crate) fn bounded_nonempty(value: &str, maximum: usize) -> bool {
    !value.is_empty() && value.len() <= maximum
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("sha256:")
        && value[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn plausible_rfc3339(value: &str) -> bool {
    (20..=64).contains(&value.len()) && OffsetDateTime::parse(value, &Rfc3339).is_ok()
}

#[cfg(test)]
mod tests {
    use super::{ArtifactResult, EventActor, VerificationDeadLetter, VerificationRequested};
    use uuid::Uuid;

    fn event() -> VerificationRequested {
        VerificationRequested {
            event_id: Uuid::new_v4(),
            occurred_at: "2026-09-03T08:00:00Z".to_owned(),
            schema_version: "1.0".to_owned(),
            actor: EventActor::System {
                id: "contract-test".to_owned(),
            },
            package_id: Uuid::new_v4(),
            release_id: Uuid::new_v4(),
            artifact_id: Uuid::new_v4(),
            object_key: "quarantine/a".to_owned(),
            digest: format!("sha256:{}", "a".repeat(64)),
        }
    }

    #[test]
    fn validates_complete_event_envelope() {
        assert!(event().validate());
    }

    #[test]
    fn rejects_wrong_schema_and_uppercase_digest() {
        let mut value = event();
        value.schema_version = "2.0".to_owned();
        assert!(!value.validate());
        value.schema_version = "1.0".to_owned();
        value.digest = format!("sha256:{}", "A".repeat(64));
        assert!(!value.validate());
    }

    #[test]
    fn validates_terminal_and_dead_letter_events() {
        let request = event();
        let result = ArtifactResult {
            event_id: Uuid::new_v4(),
            occurred_at: request.occurred_at.clone(),
            schema_version: request.schema_version.clone(),
            actor: request.actor.clone(),
            package_id: request.package_id,
            release_id: request.release_id,
            artifact_id: request.artifact_id,
            source_event_id: request.event_id,
            failure_code: None,
        };
        assert!(result.validate());
        let dead_letter = VerificationDeadLetter {
            event_id: Uuid::new_v4(),
            occurred_at: result.occurred_at,
            schema_version: result.schema_version,
            actor: result.actor,
            package_id: result.package_id,
            release_id: result.release_id,
            artifact_id: result.artifact_id,
            source_event_id: result.source_event_id,
            object_key: request.object_key,
            digest: request.digest,
            failure_code: "scanner_unavailable".to_owned(),
            delivery_count: 5,
        };
        assert!(dead_letter.validate());
    }
}
