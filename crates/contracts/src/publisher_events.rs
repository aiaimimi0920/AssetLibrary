use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{
    EventActor, PackageKind, SCHEMA_VERSION_V1,
    events::{bounded_nonempty, plausible_rfc3339},
};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PublisherResourceAction {
    Created,
    Updated,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PackageChanged {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub publisher_id: Uuid,
    pub package_id: Uuid,
    pub slug: String,
    pub kind: PackageKind,
    pub action: PublisherResourceAction,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ReleaseChanged {
    pub event_id: Uuid,
    pub occurred_at: String,
    pub schema_version: String,
    pub actor: EventActor,
    pub package_id: Uuid,
    pub release_id: Uuid,
    pub version: String,
    pub action: PublisherResourceAction,
}

impl PackageChanged {
    pub fn validate(&self) -> bool {
        valid_control(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
        ) && !self.publisher_id.is_nil()
            && !self.package_id.is_nil()
            && valid_slug(&self.slug)
    }
}

impl ReleaseChanged {
    pub fn validate(&self) -> bool {
        valid_control(
            self.event_id,
            &self.occurred_at,
            &self.schema_version,
            &self.actor,
        ) && !self.package_id.is_nil()
            && !self.release_id.is_nil()
            && bounded_nonempty(&self.version, 100)
            && semver::Version::parse(&self.version).is_ok()
    }
}

fn valid_control(id: Uuid, occurred_at: &str, schema: &str, actor: &EventActor) -> bool {
    !id.is_nil()
        && schema == SCHEMA_VERSION_V1
        && plausible_rfc3339(occurred_at)
        && actor.is_valid()
}

fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

#[cfg(test)]
mod tests {
    use super::{PackageChanged, PublisherResourceAction, ReleaseChanged};
    use crate::{EventActor, PackageKind};
    use uuid::Uuid;

    fn actor() -> EventActor {
        EventActor::Principal {
            issuer: "https://accounts.neuro.example".to_owned(),
            subject: "account-42".to_owned(),
        }
    }

    #[test]
    fn validates_publisher_resource_events() {
        let package_id = Uuid::new_v4();
        assert!(
            PackageChanged {
                event_id: Uuid::new_v4(),
                occurred_at: "2026-09-03T08:00:00Z".to_owned(),
                schema_version: "1.0".to_owned(),
                actor: actor(),
                publisher_id: Uuid::new_v4(),
                package_id,
                slug: "neuro-painter".to_owned(),
                kind: PackageKind::Art,
                action: PublisherResourceAction::Updated,
            }
            .validate()
        );
        assert!(
            ReleaseChanged {
                event_id: Uuid::new_v4(),
                occurred_at: "2026-09-03T08:00:00Z".to_owned(),
                schema_version: "1.0".to_owned(),
                actor: actor(),
                package_id,
                release_id: Uuid::new_v4(),
                version: "1.0.0".to_owned(),
                action: PublisherResourceAction::Created,
            }
            .validate()
        );
    }
}
