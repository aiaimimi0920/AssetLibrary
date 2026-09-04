use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use serde::Deserialize;

use std::path::Path;

use crate::archive::{ArchiveError, canonical_zip_digest, canonical_zip_digest_file, hex_digest};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SignatureDocument {
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    pub algorithm: String,
    pub key_id: String,
    pub digest_algorithm: String,
    pub digest: String,
    pub signature: String,
    pub public_key: String,
}

fn default_schema_version() -> u32 {
    1
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum SignatureError {
    #[error("signature document schema is unsupported")]
    UnsupportedSchema,
    #[error("signature algorithm is unsupported")]
    UnsupportedAlgorithm,
    #[error("signature digest is invalid")]
    InvalidDigest,
    #[error("signature public key is invalid")]
    InvalidPublicKey,
    #[error("signature bytes are invalid")]
    InvalidSignature,
    #[error("signature verification failed")]
    VerificationFailed,
    #[error("signature key is not the publisher's trusted key")]
    UntrustedKey,
    #[error("archive validation failed")]
    Archive(#[from] ArchiveError),
}

pub fn verify_signature_document(
    archive_bytes: &[u8],
    document: &SignatureDocument,
    excluded_name: &str,
    expected_key_id: &str,
    expected_public_key: &[u8; 32],
) -> Result<(), SignatureError> {
    let digest = canonical_zip_digest(archive_bytes, Some(excluded_name))?;
    verify_signature_digest(digest, document, expected_key_id, expected_public_key)
}

pub fn verify_signature_document_file(
    archive_path: &Path,
    document: &SignatureDocument,
    excluded_name: &str,
    expected_key_id: &str,
    expected_public_key: &[u8; 32],
) -> Result<(), SignatureError> {
    let digest = canonical_zip_digest_file(archive_path, Some(excluded_name))?;
    verify_signature_digest(digest, document, expected_key_id, expected_public_key)
}

pub fn verify_signature_digest(
    expected: [u8; 32],
    document: &SignatureDocument,
    expected_key_id: &str,
    expected_public_key: &[u8; 32],
) -> Result<(), SignatureError> {
    if document.schema_version != 1 {
        return Err(SignatureError::UnsupportedSchema);
    }
    if document.algorithm != "ed25519" || document.digest_algorithm != "sha256" {
        return Err(SignatureError::UnsupportedAlgorithm);
    }
    if document.key_id != expected_key_id {
        return Err(SignatureError::UntrustedKey);
    }
    if document.digest.len() != 64
        || !document
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(SignatureError::InvalidDigest);
    }
    let expected_hex = hex_digest(&expected);
    if document.digest != expected_hex {
        return Err(SignatureError::InvalidDigest);
    }
    let public_key = STANDARD
        .decode(document.public_key.as_bytes())
        .map_err(|_| SignatureError::InvalidPublicKey)?;
    let public_key: [u8; 32] = public_key
        .try_into()
        .map_err(|_| SignatureError::InvalidPublicKey)?;
    if &public_key != expected_public_key {
        return Err(SignatureError::UntrustedKey);
    }
    let signature = STANDARD
        .decode(document.signature.as_bytes())
        .map_err(|_| SignatureError::InvalidSignature)?;
    let signature: [u8; 64] = signature
        .try_into()
        .map_err(|_| SignatureError::InvalidSignature)?;
    verify_ed25519_message(expected_hex.as_bytes(), expected_public_key, &signature)
}

pub fn verify_ed25519_message(
    message: &[u8],
    public_key: &[u8; 32],
    signature: &[u8; 64],
) -> Result<(), SignatureError> {
    let key = VerifyingKey::from_bytes(public_key).map_err(|_| SignatureError::InvalidPublicKey)?;
    let signature = Signature::from_bytes(signature);
    key.verify(message, &signature)
        .map_err(|_| SignatureError::VerificationFailed)
}

#[cfg(test)]
mod tests {
    use super::{SignatureDocument, SignatureError, verify_signature_document};
    use base64::{Engine as _, engine::general_purpose::STANDARD};
    use ed25519_dalek::{Signer, SigningKey};
    use std::io::{Cursor, Write};
    use zip::ZipWriter;
    use zip::write::SimpleFileOptions;

    fn archive() -> Vec<u8> {
        let mut output = Cursor::new(Vec::new());
        let mut writer = ZipWriter::new(&mut output);
        writer
            .start_file("manifest.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"manifest").unwrap();
        writer
            .start_file("signature.json", SimpleFileOptions::default())
            .unwrap();
        writer.write_all(b"signature").unwrap();
        writer.finish().unwrap();
        output.into_inner()
    }

    #[test]
    fn verifies_loom_compatible_ed25519_document() {
        let bytes = archive();
        let digest = crate::canonical_zip_digest(&bytes, Some("signature.json")).unwrap();
        let digest_hex = crate::hex_digest(&digest);
        let signing_key = SigningKey::from_bytes(&[7u8; 32]);
        let signature = signing_key.sign(digest_hex.as_bytes());
        let document = SignatureDocument {
            schema_version: 1,
            algorithm: "ed25519".into(),
            key_id: "key-1".into(),
            digest_algorithm: "sha256".into(),
            digest: digest_hex,
            signature: STANDARD.encode(signature.to_bytes()),
            public_key: STANDARD.encode(signing_key.verifying_key().to_bytes()),
        };
        assert!(
            verify_signature_document(
                &bytes,
                &document,
                "signature.json",
                "key-1",
                &signing_key.verifying_key().to_bytes(),
            )
            .is_ok()
        );

        let untrusted = SigningKey::from_bytes(&[8u8; 32]);
        assert_eq!(
            verify_signature_document(
                &bytes,
                &document,
                "signature.json",
                "key-1",
                &untrusted.verifying_key().to_bytes(),
            ),
            Err(SignatureError::UntrustedKey)
        );
    }
}
