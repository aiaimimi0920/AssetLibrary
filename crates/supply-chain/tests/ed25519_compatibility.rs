use assetlibrary_supply_chain::verify_ed25519_message;
use ed25519_dalek::{Signature, VerifyingKey};
use serde_json::Value;

fn bytes(value: &Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

#[test]
fn production_verifier_preserves_frozen_acceptance_and_rejection() {
    let oracle: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/ed25519-compatibility-v1.json"
    ))
    .unwrap();
    let cases = oracle["verification"].as_array().unwrap();
    assert_eq!(cases.len(), 274);
    let mut accepted_weak = 0;
    for case in cases {
        let id = case["id"].as_str().unwrap();
        let public = bytes(&case["public_key_hex"]).try_into().unwrap();
        let signature = bytes(&case["signature_hex"]).try_into().unwrap();
        let message = bytes(&case["message_hex"]);
        let result = verify_ed25519_message(&message, &public, &signature);
        assert_eq!(result.is_ok(), case["verify"].as_bool().unwrap(), "{id}");
        assert_eq!(
            serde_json::to_value(result.err().map(|error| format!("{error:?}"))).unwrap(),
            case["production_error"],
            "{id}: error mapping"
        );
        let parsed = VerifyingKey::from_bytes(&public);
        assert_eq!(
            parsed.is_ok(),
            case["key_parses"].as_bool().unwrap(),
            "{id}: key parse"
        );
        assert_eq!(
            serde_json::to_value(parsed.as_ref().ok().map(|key| key.is_weak())).unwrap(),
            case["weak"],
            "{id}: weak classification"
        );
        assert_eq!(
            parsed.as_ref().is_ok_and(|key| key
                .verify_strict(&message, &Signature::from_bytes(&signature))
                .is_ok()),
            case["verify_strict"].as_bool().unwrap(),
            "{id}: strict diagnostic"
        );
        if case["verify"] == true && case["weak"] == true {
            accepted_weak += 1;
        }
    }
    // Existing behavior only. This upgrade does not fix weak-key admission.
    assert_eq!(accepted_weak, 8);
}
