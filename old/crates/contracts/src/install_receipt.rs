use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::Version;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    DownloadArtifact, PackageKind, SCHEMA_VERSION_V1, SigningKeyAlgorithm,
    events::plausible_rfc3339,
};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct HostApiSupport {
    pub version: String,
    pub features: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledFramework {
    pub id: String,
    pub version: String,
    pub ready: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstallHostProfile {
    pub loom_version: String,
    pub hook_version: String,
    pub platform: String,
    pub loom_capability_api: HostApiSupport,
    pub hook_extension_api: HostApiSupport,
    pub surface_api: HostApiSupport,
    pub surface_nodes: Vec<String>,
    pub frameworks: Vec<InstalledFramework>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct CreateInstallChallengeRequest {
    pub receipt_id: Uuid,
    pub client_instance_id: Uuid,
    pub receipt_public_key_base64: String,
    pub host: InstallHostProfile,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstallPackage {
    pub package_id: Uuid,
    pub publisher_id: Uuid,
    pub publisher_slug: String,
    pub package_slug: String,
    pub kind: PackageKind,
    pub version: String,
    pub permissions: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TrustedPublisherKey {
    pub key_id: String,
    pub algorithm: SigningKeyAlgorithm,
    pub public_key_base64: String,
    pub fingerprint: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstallChallenge {
    pub schema_version: String,
    pub receipt_id: Uuid,
    pub download_session_id: Uuid,
    pub client_instance_id: Uuid,
    pub package: InstallPackage,
    pub artifact: DownloadArtifact,
    pub archive_sha256: String,
    pub trusted_signing_key: TrustedPublisherKey,
    pub host_profile_sha256: String,
    pub nonce: Uuid,
    pub issued_at: String,
    pub expires_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct VerifyInstallReceiptRequest {
    pub installed_at_epoch_seconds: i64,
    pub signature_base64: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstallReceipt {
    pub schema_version: String,
    pub receipt_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub digest: String,
    pub status: String,
    pub installed_at: String,
    pub verified_at: String,
}

impl HostApiSupport {
    fn validate(&self) -> bool {
        api_version(&self.version) && unique_safe(&self.features, 128)
    }
}

impl InstallHostProfile {
    pub fn validate(&self) -> bool {
        Version::parse(&self.loom_version).is_ok()
            && Version::parse(&self.hook_version).is_ok()
            && platform(&self.platform)
            && self.loom_capability_api.validate()
            && self.hook_extension_api.validate()
            && self.surface_api.validate()
            && unique_safe(&self.surface_nodes, 256)
            && self.frameworks.len() <= 64
            && self.frameworks.iter().all(InstalledFramework::validate)
            && self
                .frameworks
                .iter()
                .map(|framework| framework.id.as_str())
                .collect::<BTreeSet<_>>()
                .len()
                == self.frameworks.len()
    }
}

impl InstalledFramework {
    fn validate(&self) -> bool {
        package_reference(&self.id) && Version::parse(&self.version).is_ok()
    }
}

impl CreateInstallChallengeRequest {
    pub fn validate(&self) -> bool {
        !self.receipt_id.is_nil()
            && !self.client_instance_id.is_nil()
            && self.receipt_public_key().is_some()
            && self.host.validate()
    }

    pub fn receipt_public_key(&self) -> Option<[u8; 32]> {
        let decoded = STANDARD.decode(&self.receipt_public_key_base64).ok()?;
        if STANDARD.encode(&decoded) != self.receipt_public_key_base64 {
            return None;
        }
        decoded.try_into().ok()
    }
}

impl InstallChallenge {
    pub fn validate(&self) -> bool {
        let valid_window = OffsetDateTime::parse(&self.issued_at, &Rfc3339)
            .ok()
            .zip(OffsetDateTime::parse(&self.expires_at, &Rfc3339).ok())
            .is_some_and(|(issued, expires)| issued < expires);
        self.schema_version == SCHEMA_VERSION_V1
            && !self.receipt_id.is_nil()
            && !self.download_session_id.is_nil()
            && !self.client_instance_id.is_nil()
            && !self.package.package_id.is_nil()
            && !self.package.publisher_id.is_nil()
            && package_reference(&format!(
                "{}/{}",
                self.package.publisher_slug, self.package.package_slug
            ))
            && Version::parse(&self.package.version).is_ok()
            && unique_safe(&self.package.permissions, 64)
            && self.artifact.validate()
            && digest(&self.archive_sha256)
            && digest(&self.host_profile_sha256)
            && !self.nonce.is_nil()
            && plausible_rfc3339(&self.issued_at)
            && plausible_rfc3339(&self.expires_at)
            && valid_window
            && !self.trusted_signing_key.key_id.is_empty()
            && self.trusted_signing_key.key_id.len() <= 80
            && canonical_public_key(&self.trusted_signing_key.public_key_base64)
            && self
                .trusted_signing_key
                .fingerprint
                .strip_prefix("sha256:")
                .is_some_and(digest)
    }
}

impl VerifyInstallReceiptRequest {
    pub fn validate(&self) -> bool {
        self.installed_at_epoch_seconds > 0
            && STANDARD
                .decode(&self.signature_base64)
                .ok()
                .is_some_and(|bytes| {
                    bytes.len() == 64 && STANDARD.encode(bytes) == self.signature_base64
                })
    }

    pub fn signature(&self) -> Option<[u8; 64]> {
        STANDARD
            .decode(&self.signature_base64)
            .ok()?
            .try_into()
            .ok()
    }
}

pub fn canonical_install_receipt_payload(
    challenge: &InstallChallenge,
    installed_at_epoch_seconds: i64,
) -> Vec<u8> {
    format!(
        "assetlibrary-install-receipt-v1\nreceipt_id={}\ndownload_session_id={}\nrelease_id={}\nartifact_id={}\ncanonical_sha256={}\narchive_sha256={}\nhost_profile_sha256={}\nnonce={}\nclient_instance_id={}\ninstalled_at={}\n",
        challenge.receipt_id,
        challenge.download_session_id,
        challenge.artifact.release_id,
        challenge.artifact.artifact_id,
        challenge.artifact.digest,
        challenge.archive_sha256,
        challenge.host_profile_sha256,
        challenge.nonce,
        challenge.client_instance_id,
        installed_at_epoch_seconds,
    )
    .into_bytes()
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn canonical_public_key(value: &str) -> bool {
    STANDARD
        .decode(value)
        .ok()
        .is_some_and(|bytes| bytes.len() == 32 && STANDARD.encode(bytes) == value)
}

fn api_version(value: &str) -> bool {
    value.split_once('.').is_some_and(|(major, minor)| {
        !major.is_empty()
            && !minor.is_empty()
            && major.bytes().all(|byte| byte.is_ascii_digit())
            && minor.bytes().all(|byte| byte.is_ascii_digit())
    })
}

fn platform(value: &str) -> bool {
    value.split_once('-').is_some_and(|(os, arch)| {
        !os.is_empty()
            && !arch.is_empty()
            && os.bytes().all(|byte| byte.is_ascii_lowercase())
            && arch
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn package_reference(value: &str) -> bool {
    let mut parts = value.split('/');
    let valid = parts.next().is_some_and(safe_id) && parts.next().is_some_and(safe_id);
    valid && parts.next().is_none()
}

fn unique_safe(values: &[String], maximum: usize) -> bool {
    values.len() <= maximum
        && values.iter().all(|value| safe_label(value))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && !value.contains("..")
}

fn safe_label(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 256
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use super::{CreateInstallChallengeRequest, VerifyInstallReceiptRequest};

    #[test]
    fn request_rejects_non_canonical_client_key() {
        let value = serde_json::from_str::<CreateInstallChallengeRequest>(include_str!(
            "../../../contracts/fixtures/install-challenge-request.v1.json"
        ))
        .unwrap();
        assert!(value.validate());
    }

    #[test]
    fn receipt_signature_requires_canonical_ed25519_bytes() {
        let request = VerifyInstallReceiptRequest {
            installed_at_epoch_seconds: 1_800_000_000,
            signature_base64: base64::Engine::encode(
                &base64::engine::general_purpose::STANDARD,
                [7u8; 64],
            ),
        };
        assert!(request.validate());
        assert_eq!(request.signature(), Some([7u8; 64]));
    }
}
