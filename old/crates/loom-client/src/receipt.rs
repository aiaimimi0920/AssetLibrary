use assetlibrary_contracts::{
    CreateInstallChallengeRequest, InstallChallenge, InstallHostProfile, InstallReceipt,
    VerifyInstallReceiptRequest, canonical_install_receipt_payload,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use getrandom::{SysRng, rand_core::UnwrapErr};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use uuid::Uuid;

use crate::{AccountBearer, ClientError, LoomApiClient, LoomDownloadSession};

pub struct ReceiptProofKey {
    receipt_id: Uuid,
    client_instance_id: Uuid,
    host_profile_sha256: String,
    signing_key: SigningKey,
}

impl fmt::Debug for ReceiptProofKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ReceiptProofKey")
            .field("receipt_id", &self.receipt_id)
            .field("client_instance_id", &self.client_instance_id)
            .field("signing_key", &"[REDACTED]")
            .finish()
    }
}

impl ReceiptProofKey {
    pub fn generate(
        client_instance_id: Uuid,
        host: InstallHostProfile,
    ) -> Result<(Self, CreateInstallChallengeRequest), ClientError> {
        if client_instance_id.is_nil() || !host.validate() {
            return Err(ClientError::InvalidInput("invalid Loom host profile"));
        }
        let signing_key = SigningKey::generate(&mut UnwrapErr(SysRng));
        let receipt_id = Uuid::new_v4();
        let public_key = STANDARD.encode(signing_key.verifying_key().to_bytes());
        let host_profile_sha256 = hex::encode(Sha256::digest(
            serde_json::to_vec(&host).map_err(|_| ClientError::InvalidInput("invalid host"))?,
        ));
        let request = CreateInstallChallengeRequest {
            receipt_id,
            client_instance_id,
            receipt_public_key_base64: public_key,
            host,
        };
        Ok((
            Self {
                receipt_id,
                client_instance_id,
                host_profile_sha256,
                signing_key,
            },
            request,
        ))
    }

    pub fn bind(
        self,
        session: &LoomDownloadSession,
        challenge: InstallChallenge,
    ) -> Result<PendingReceipt, ClientError> {
        if !challenge.validate()
            || challenge.receipt_id != self.receipt_id
            || challenge.client_instance_id != self.client_instance_id
            || challenge.download_session_id != session.session_id
            || challenge.artifact != session.artifact
            || challenge.host_profile_sha256 != self.host_profile_sha256
        {
            return Err(ClientError::InvalidResponse);
        }
        Ok(PendingReceipt {
            challenge,
            signing_key: self.signing_key,
        })
    }
}

pub struct PendingReceipt {
    challenge: InstallChallenge,
    signing_key: SigningKey,
}

impl fmt::Debug for PendingReceipt {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("PendingReceipt")
            .field("receipt_id", &self.challenge.receipt_id)
            .field("signing_key", &"[REDACTED]")
            .finish()
    }
}

impl PendingReceipt {
    pub fn challenge(&self) -> &InstallChallenge {
        &self.challenge
    }

    pub fn sign(
        self,
        installed_at_epoch_seconds: i64,
        idempotency_key: String,
    ) -> Result<QueuedReceipt, ClientError> {
        if installed_at_epoch_seconds <= 0 || !valid_idempotency_key(&idempotency_key) {
            return Err(ClientError::InvalidInput("invalid receipt completion"));
        }
        let signature = self.signing_key.sign(&canonical_install_receipt_payload(
            &self.challenge,
            installed_at_epoch_seconds,
        ));
        let request = VerifyInstallReceiptRequest {
            installed_at_epoch_seconds,
            signature_base64: STANDARD.encode(signature.to_bytes()),
        };
        Ok(QueuedReceipt {
            receipt_id: self.challenge.receipt_id,
            release_id: self.challenge.artifact.release_id,
            artifact_id: self.challenge.artifact.artifact_id,
            canonical_sha256: self.challenge.artifact.digest,
            idempotency_key,
            request,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct QueuedReceipt {
    pub receipt_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub canonical_sha256: String,
    pub idempotency_key: String,
    pub request: VerifyInstallReceiptRequest,
}

impl QueuedReceipt {
    pub fn validate(&self) -> bool {
        !self.receipt_id.is_nil()
            && !self.release_id.is_nil()
            && !self.artifact_id.is_nil()
            && digest(&self.canonical_sha256)
            && valid_idempotency_key(&self.idempotency_key)
            && self.request.validate()
    }

    pub async fn submit(
        &self,
        api: &LoomApiClient,
        account: &AccountBearer,
    ) -> Result<InstallReceipt, ClientError> {
        if !self.validate() {
            return Err(ClientError::InvalidInput("invalid queued receipt"));
        }
        let receipt = api
            .verify_install_receipt(
                account,
                self.receipt_id,
                &self.idempotency_key,
                &self.request,
            )
            .await?;
        if receipt.release_id != self.release_id
            || receipt.artifact_id != self.artifact_id
            || receipt.digest != self.canonical_sha256
        {
            return Err(ClientError::InvalidResponse);
        }
        Ok(receipt)
    }
}

fn valid_idempotency_key(value: &str) -> bool {
    (8..=200).contains(&value.len())
        && value.trim() == value
        && !value.chars().any(char::is_control)
}

fn digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::ReceiptProofKey;
    use assetlibrary_contracts::{HostApiSupport, InstallHostProfile};
    use uuid::Uuid;

    #[test]
    fn proof_private_key_is_never_debugged() {
        let api = HostApiSupport {
            version: "1.0".to_owned(),
            features: Vec::new(),
        };
        let host = InstallHostProfile {
            loom_version: "1.0.0".to_owned(),
            hook_version: "1.0.0".to_owned(),
            platform: "windows-x64".to_owned(),
            loom_capability_api: api.clone(),
            hook_extension_api: api.clone(),
            surface_api: api,
            surface_nodes: Vec::new(),
            frameworks: Vec::new(),
        };
        let (proof, request) = ReceiptProofKey::generate(Uuid::new_v4(), host).unwrap();
        let rendered = format!("{proof:?}");
        assert!(rendered.contains("[REDACTED]"));
        assert!(!rendered.contains(&request.receipt_public_key_base64));
    }
}
