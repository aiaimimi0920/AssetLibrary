use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use assetlibrary_contracts::DownloadClientType;

type HmacSha256 = Hmac<Sha256>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct TicketClaims {
    pub issuer: String,
    pub audience: String,
    pub purpose: String,
    pub session_id: Uuid,
    pub publisher_id: Uuid,
    pub package_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub signing_key_id: String,
    pub client_type: DownloadClientType,
    pub digest: String,
    pub object_key: String,
    pub path: String,
    pub nonce: Uuid,
    pub issued_at: i64,
    pub not_before: i64,
    pub expires_at: i64,
}

#[derive(Clone)]
pub struct TicketSigner {
    secret: Vec<u8>,
}

impl TicketSigner {
    pub fn new(secret: Vec<u8>) -> Result<Self, &'static str> {
        if secret.len() < 32 {
            return Err("ticket secret is too short");
        }
        Ok(Self { secret })
    }

    pub fn issue(&self, claims: &TicketClaims) -> Result<(String, Vec<u8>), &'static str> {
        let payload = serde_json::to_vec(claims).map_err(|_| "ticket serialization failed")?;
        let encoded = URL_SAFE_NO_PAD.encode(payload);
        let signing_input = format!("v1.{encoded}");
        let mut mac = HmacSha256::new_from_slice(&self.secret)
            .map_err(|_| "ticket signer initialization failed")?;
        mac.update(signing_input.as_bytes());
        let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
        let token = format!("{signing_input}.{signature}");
        Ok((token.clone(), Sha256::digest(token.as_bytes()).to_vec()))
    }

    #[cfg(test)]
    fn verify(&self, token: &str) -> Result<TicketClaims, &'static str> {
        let mut segments = token.split('.');
        if segments.next() != Some("v1") {
            return Err("unsupported ticket version");
        }
        let payload = segments.next().ok_or("missing ticket payload")?;
        let signature = segments.next().ok_or("missing ticket signature")?;
        if segments.next().is_some() {
            return Err("unexpected ticket segment");
        }
        let mut mac = HmacSha256::new_from_slice(&self.secret).map_err(|_| "invalid secret")?;
        mac.update(format!("v1.{payload}").as_bytes());
        let signature = URL_SAFE_NO_PAD
            .decode(signature)
            .map_err(|_| "invalid ticket signature")?;
        mac.verify_slice(&signature)
            .map_err(|_| "invalid ticket signature")?;
        let payload = URL_SAFE_NO_PAD
            .decode(payload)
            .map_err(|_| "invalid ticket payload")?;
        serde_json::from_slice(&payload).map_err(|_| "invalid ticket claims")
    }
}

#[cfg(test)]
mod tests {
    use super::{TicketClaims, TicketSigner};
    use uuid::Uuid;

    fn claims() -> TicketClaims {
        TicketClaims {
            issuer: "assetlibrary".to_owned(),
            audience: "download-edge".to_owned(),
            purpose: "download".to_owned(),
            session_id: Uuid::new_v4(),
            publisher_id: Uuid::new_v4(),
            package_id: Uuid::new_v4(),
            release_id: Uuid::new_v4(),
            artifact_id: Uuid::new_v4(),
            signing_key_id: "fixture-key".to_owned(),
            client_type: assetlibrary_contracts::DownloadClientType::Loom,
            digest: "a".repeat(64),
            object_key: format!("sha256/aa/{}", "a".repeat(64)),
            path: format!("/restricted/sha256/{}/package.zip", "a".repeat(64)),
            nonce: Uuid::new_v4(),
            issued_at: 1_700_000_000,
            not_before: 1_700_000_000,
            expires_at: 1_700_000_300,
        }
    }

    #[test]
    fn signed_claims_round_trip_and_tampering_fails() {
        let signer = TicketSigner::new(vec![42; 32]).unwrap();
        let claims = claims();
        let (token, hash) = signer.issue(&claims).unwrap();
        assert_eq!(signer.verify(&token).unwrap(), claims);
        assert_eq!(hash.len(), 32);
        let tampered = format!("{}x", token);
        assert!(signer.verify(&tampered).is_err());
    }

    #[test]
    fn frozen_ticket_and_database_hash_remain_compatible() {
        let golden: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../fixtures/crypto/compatibility-v1.json"
        ))
        .unwrap();
        let claims: TicketClaims =
            serde_json::from_value(golden["ticket"]["claims"].clone()).unwrap();
        let signer = TicketSigner::new(vec![42; 32]).unwrap();
        let (encoded, hash) = signer.issue(&claims).unwrap();
        assert_eq!(
            encoded,
            golden["ticket"]["encoded_ticket"].as_str().unwrap()
        );
        assert_eq!(hex::encode(hash), golden["ticket"]["database_sha256_hex"]);
        assert_eq!(signer.verify(&encoded).unwrap(), claims);
        assert!(
            TicketSigner::new(vec![43; 32])
                .unwrap()
                .verify(&encoded)
                .is_err()
        );
        assert!(TicketSigner::new(vec![42; 31]).is_err());

        for vector in golden["hmac_boundaries"].as_array().unwrap() {
            let signer =
                TicketSigner::new(vec![42; vector["key_bytes"].as_u64().unwrap() as usize])
                    .unwrap();
            let (encoded, hash) = signer.issue(&claims).unwrap();
            assert_eq!(
                encoded.rsplit('.').next().unwrap(),
                vector["signature_base64url"]
            );
            assert_eq!(hex::encode(hash), vector["database_sha256_hex"]);
            assert_eq!(signer.verify(&encoded).unwrap(), claims);
        }
    }
}
