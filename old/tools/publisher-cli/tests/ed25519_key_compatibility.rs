use ed25519_dalek::pkcs8::{DecodePrivateKey, EncodePrivateKey};
use ed25519_dalek::{Signature, Signer, SigningKey, Verifier};
use pkcs8::LineEnding;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

fn oracle() -> Value {
    serde_json::from_str(include_str!(
        "../../../fixtures/crypto/ed25519-compatibility-v1.json"
    ))
    .unwrap()
}

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn deterministic_signatures_and_exported_keys_match_old_bytes() {
    let oracle = oracle();
    assert_eq!(oracle["keys"].as_array().unwrap().len(), 5);
    assert_eq!(oracle["signatures"].as_array().unwrap().len(), 70);
    let mut keys = BTreeMap::new();
    for case in oracle["keys"].as_array().unwrap() {
        let id = case["id"].as_str().unwrap();
        let seed = bytes(&case["seed_hex"]).try_into().unwrap();
        let key = SigningKey::from_bytes(&seed);
        let public = key.verifying_key().to_bytes();
        assert_eq!(hex(&public), case["public_key_hex"], "{id}: public");
        assert_eq!(
            hex(&Sha256::digest(public)),
            case["fingerprint_sha256_hex"],
            "{id}: fingerprint"
        );
        assert_eq!(
            hex(key.to_pkcs8_der().unwrap().as_bytes()),
            case["pkcs8_der_hex"],
            "{id}: DER"
        );
        for (name, ending) in [("lf", LineEnding::LF), ("crlf", LineEnding::CRLF)] {
            let pem = key.to_pkcs8_pem(ending).unwrap();
            assert_eq!(
                hex(&Sha256::digest(pem.as_bytes())),
                case[format!("pkcs8_pem_{name}_sha256_hex")],
                "{id}: {name}"
            );
        }
        keys.insert(id.to_owned(), key);
    }
    for case in oracle["signatures"].as_array().unwrap() {
        let key = &keys[case["key"].as_str().unwrap()];
        let message = bytes(&case["message_hex"]);
        let signature = key.sign(&message);
        assert_eq!(
            hex(&signature.to_bytes()),
            case["signature_hex"],
            "{} / {}",
            case["key"],
            case["message"]
        );
        let old_signature =
            Signature::from_bytes(&bytes(&case["signature_hex"]).try_into().unwrap());
        key.verifying_key()
            .verify(&message, &old_signature)
            .unwrap();
    }
}

#[test]
fn key_import_acceptance_and_rejection_match_old_parser() {
    let oracle = oracle();
    for (group, count) in [("der", 87), ("pem", 8)] {
        let cases = oracle[group].as_array().unwrap();
        assert_eq!(cases.len(), count);
        for case in cases {
            let id = case["id"].as_str().unwrap();
            let key = if group == "der" {
                SigningKey::from_pkcs8_der(&bytes(&case["input_hex"]))
            } else {
                SigningKey::from_pkcs8_pem(
                    std::str::from_utf8(&bytes(&case["input_utf8_hex"])).unwrap(),
                )
            };
            assert_eq!(
                key.is_ok(),
                case["accepted"].as_bool().unwrap(),
                "{group}/{id}"
            );
            assert_eq!(
                serde_json::to_value(key.ok().map(|key| hex(&key.verifying_key().to_bytes())))
                    .unwrap(),
                case["public_key_hex"],
                "{group}/{id}"
            );
        }
    }
}
