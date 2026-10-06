use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::{SCHEMA_VERSION_V1, events::plausible_rfc3339};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SigningKeyAlgorithm {
    Ed25519,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SigningKeyStatus {
    Active,
    Revoked,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RegisterSigningKeyRequest {
    pub key_id: String,
    pub algorithm: SigningKeyAlgorithm,
    pub public_key_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct RevokeSigningKeyRequest {
    pub reason: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherSigningKey {
    pub publisher_id: Uuid,
    pub key_id: String,
    pub algorithm: SigningKeyAlgorithm,
    pub public_key_base64: String,
    pub fingerprint: String,
    pub status: SigningKeyStatus,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct PublisherSigningKeyPage {
    pub schema_version: String,
    pub items: Vec<PublisherSigningKey>,
    pub next_cursor: Option<String>,
}

impl RegisterSigningKeyRequest {
    pub fn validate(&self) -> bool {
        valid_signing_key_id(&self.key_id) && self.public_key().is_some()
    }

    pub fn public_key(&self) -> Option<[u8; 32]> {
        let decoded = STANDARD.decode(&self.public_key_base64).ok()?;
        if STANDARD.encode(&decoded) != self.public_key_base64 {
            return None;
        }
        decoded.try_into().ok()
    }
}

impl RevokeSigningKeyRequest {
    pub fn validate(&self) -> bool {
        bounded_line(&self.reason, 500)
    }
}

impl PublisherSigningKey {
    pub fn validate(&self) -> bool {
        !self.publisher_id.is_nil()
            && valid_signing_key_id(&self.key_id)
            && canonical_public_key(&self.public_key_base64)
            && valid_fingerprint(&self.fingerprint)
            && plausible_rfc3339(&self.created_at)
            && match self.status {
                SigningKeyStatus::Active => self.revoked_at.is_none(),
                SigningKeyStatus::Revoked => {
                    self.revoked_at.as_deref().is_some_and(plausible_rfc3339)
                }
            }
    }
}

impl PublisherSigningKeyPage {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.items.len() <= 100
            && self
                .next_cursor
                .as_deref()
                .is_none_or(|value| value.len() <= 256)
            && self.items.iter().all(PublisherSigningKey::validate)
    }
}

pub fn valid_signing_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn canonical_public_key(value: &str) -> bool {
    STANDARD
        .decode(value)
        .ok()
        .is_some_and(|bytes| bytes.len() == 32 && STANDARD.encode(bytes) == value)
}

fn valid_fingerprint(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn bounded_line(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.chars().count() <= maximum
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::{PublisherSigningKeyPage, RegisterSigningKeyRequest, SigningKeyAlgorithm};

    #[test]
    fn shared_signing_key_fixture_is_valid() {
        let page: PublisherSigningKeyPage = serde_json::from_str(include_str!(
            "../../../contracts/fixtures/publisher-signing-key-page.v1.json"
        ))
        .expect("shared signing-key fixture must deserialize");
        assert!(page.validate());
    }

    #[test]
    fn accepts_only_canonical_ed25519_public_keys() {
        let request = RegisterSigningKeyRequest {
            key_id: "release-2026".into(),
            algorithm: SigningKeyAlgorithm::Ed25519,
            public_key_base64: "ERERERERERERERERERERERERERERERERERERERERERE=".into(),
        };
        assert!(request.validate());
        assert_eq!(request.public_key(), Some([0x11; 32]));

        let mut invalid = request;
        invalid.public_key_base64 = "ERER".into();
        assert!(!invalid.validate());
    }
}
