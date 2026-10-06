use assetlibrary_supply_chain::{
    SignatureDocument, canonical_zip_digest, hex_digest, sha256_digest, sha256_digest_file,
    verify_signature_document,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/crypto/compatibility-v1.json"
    ))
    .unwrap()
}

#[test]
fn raw_and_streamed_sha256_match_frozen_block_boundaries() {
    let golden = fixture();
    for vector in golden["sha256_boundaries"].as_array().unwrap() {
        let size = vector["size"].as_u64().unwrap();
        let bytes: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        assert_eq!(hex_digest(&sha256_digest(&bytes)), vector["sha256_hex"]);
        let file = tempfile::NamedTempFile::new().unwrap();
        std::fs::write(file.path(), &bytes).unwrap();
        let (streamed, actual_size) = sha256_digest_file(file.path(), size).unwrap();
        assert_eq!(actual_size, size);
        assert_eq!(hex_digest(&streamed), vector["sha256_hex"]);
    }
}

#[test]
fn frozen_archive_digest_fingerprint_and_signature_remain_valid() {
    let golden = fixture();
    let archive = STANDARD
        .decode(golden["archive"]["zip_base64"].as_str().unwrap())
        .unwrap();
    let canonical = canonical_zip_digest(&archive, Some("signature.json")).unwrap();
    assert_eq!(
        hex_digest(&canonical),
        golden["archive"]["canonical_sha256_hex"]
    );
    assert_eq!(
        hex_digest(&sha256_digest(&archive)),
        golden["archive"]["raw_sha256_hex"]
    );
    let public_key: [u8; 32] = STANDARD
        .decode(golden["signature"]["public_key_base64"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    assert_eq!(
        format!("sha256:{}", hex_digest(&sha256_digest(&public_key))),
        golden["signature"]["fingerprint"]
    );
    let document = SignatureDocument {
        schema_version: 1,
        algorithm: "ed25519".into(),
        key_id: "synthetic-wire-fixture".into(),
        digest_algorithm: "sha256".into(),
        digest: golden["archive"]["canonical_sha256_hex"]
            .as_str()
            .unwrap()
            .into(),
        signature: golden["signature"]["ed25519_base64"]
            .as_str()
            .unwrap()
            .into(),
        public_key: golden["signature"]["public_key_base64"]
            .as_str()
            .unwrap()
            .into(),
    };
    verify_signature_document(
        &archive,
        &document,
        "signature.json",
        "synthetic-wire-fixture",
        &public_key,
    )
    .unwrap();
    let mut changed = document;
    changed.digest.replace_range(0..1, "0");
    assert!(
        verify_signature_document(
            &archive,
            &changed,
            "signature.json",
            "synthetic-wire-fixture",
            &public_key
        )
        .is_err()
    );
}
