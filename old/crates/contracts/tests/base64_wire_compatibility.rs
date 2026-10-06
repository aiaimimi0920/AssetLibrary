use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde_json::Value;

fn golden() -> Value {
    // Captured with base64 0.22.1 before the dependency update. Never regenerate
    // this versioned oracle with the implementation being tested.
    serde_json::from_str(include_str!(
        "../../../fixtures/crypto/base64-compatibility-v1.json"
    ))
    .unwrap()
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn encodings_preserve_frozen_ticket_cursor_signature_and_checksum_bytes() {
    let golden = golden();
    assert_eq!(golden["schema_version"], 1);
    let cases = golden["encodings"].as_array().unwrap();
    assert_eq!(cases.len(), 100);
    for case in cases {
        let encoded = case["bytes_hex"].as_str().unwrap();
        assert_eq!(encoded.len() % 2, 0);
        let bytes: Vec<u8> = (0..encoded.len())
            .step_by(2)
            .map(|index| u8::from_str_radix(&encoded[index..index + 2], 16).unwrap())
            .collect();
        let label = case["label"].as_str().unwrap();
        assert_eq!(STANDARD.encode(&bytes), case["standard"], "{label}");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(&bytes),
            case["url_safe_no_pad"],
            "{label}"
        );
    }
}

#[test]
fn strict_decoding_preserves_the_old_acceptance_boundary() {
    let golden = golden();
    let cases = golden["decode_cases"].as_array().unwrap();
    assert_eq!(cases.len(), 466);
    for case in cases {
        let input = case["input"].as_str().unwrap();
        for (field, engine) in [("standard", STANDARD), ("url_safe_no_pad", URL_SAFE_NO_PAD)] {
            let actual = engine.decode(input).ok().map(|bytes| hex(&bytes));
            let expected = if case[field].is_null() {
                None
            } else {
                Some(case[field].as_str().unwrap().to_owned())
            };
            // Error wording/variant fields are not wire semantics. A formerly
            // rejected input becoming accepted is a compatibility failure.
            assert_eq!(actual, expected, "{field}: {input:?}");
        }
    }
}
