use assetlibrary_contracts::{
    InstallChallenge, VerifyInstallReceiptRequest, canonical_install_receipt_payload,
};
use assetlibrary_loom_client::QueuedReceipt;
use assetlibrary_supply_chain::verify_ed25519_message;
use serde_json::Value;

#[test]
fn stored_receipt_and_canonical_payload_match_old_bytes() {
    let oracle: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/ed25519-compatibility-v1.json"
    ))
    .unwrap();
    let receipt = &oracle["receipt"];
    let challenge_json = receipt["challenge_json"].as_str().unwrap();
    let challenge: InstallChallenge = serde_json::from_str(challenge_json).unwrap();
    assert!(challenge.validate());
    assert_eq!(serde_json::to_string(&challenge).unwrap(), challenge_json);
    let request_json = receipt["request_json"].as_str().unwrap();
    let request: VerifyInstallReceiptRequest = serde_json::from_str(request_json).unwrap();
    assert!(request.validate());
    assert_eq!(serde_json::to_string(&request).unwrap(), request_json);
    let payload = canonical_install_receipt_payload(&challenge, request.installed_at_epoch_seconds);
    assert_eq!(hex::encode(&payload), receipt["payload_hex"]);
    let public = hex::decode(oracle["keys"][1]["public_key_hex"].as_str().unwrap())
        .unwrap()
        .try_into()
        .unwrap();
    verify_ed25519_message(&payload, &public, &request.signature().unwrap()).unwrap();
    let stored: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/queued-receipt-v1.json"
    ))
    .unwrap();
    let wire = stored["queued_receipt_json"].as_str().unwrap();
    let queued: QueuedReceipt = serde_json::from_str(wire).unwrap();
    assert!(queued.validate());
    assert_eq!(queued.request, request);
    assert_eq!(queued.receipt_id, challenge.receipt_id);
    assert_eq!(queued.release_id, challenge.artifact.release_id);
    assert_eq!(queued.artifact_id, challenge.artifact.artifact_id);
    assert_eq!(queued.canonical_sha256, challenge.artifact.digest);
    assert_eq!(serde_json::to_string(&queued).unwrap(), wire);
    let extra_field = wire.strip_suffix('}').unwrap().to_owned() + ",\"unexpected\":true}";
    assert!(serde_json::from_str::<QueuedReceipt>(&extra_field).is_err());
}
