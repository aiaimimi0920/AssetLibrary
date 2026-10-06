#[path = "../examples/build_signed_fixture.rs"]
mod signed_fixture;

use assetlibrary_supply_chain::{SignatureDocument, hex_digest, verify_signature_digest};
use ed25519_dalek::SigningKey;
use serde_json::{Value, json};
use std::{
    fs,
    path::Path,
    process::{Command, ExitStatus, Stdio},
    time::{Duration, Instant},
};

fn invoke(directory: &Path) -> ExitStatus {
    let mut command = Command::new(env!("CARGO_BIN_EXE_assetlibrary-scanner-worker"));
    command
        .arg("--inspect-local")
        .current_dir(directory)
        .env_clear()
        .env(
            "ASSETLIBRARY_METRICS_BIND",
            "invalid:must-not-initialize-telemetry",
        )
        .env("DATABASE_URL", "invalid:must-not-initialize-database")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
        command.env("SystemRoot", std::env::var_os("SystemRoot").unwrap());
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if let Some(status) = child.try_wait().unwrap() {
            return status;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            child.wait().unwrap();
            panic!("local inspector exceeded its test deadline");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn prepare(directory: &Path) -> Value {
    let metadata = signed_fixture::write_fixture(&directory.join("artifact.zip")).unwrap();
    let request = json!({
        "kind": "art", "publisher_slug": "neuro-fixture-publisher", "package_slug": "neuro-starter-art",
        "version": "1.0.0-dev", "permissions": [], "size_bytes": metadata["size_bytes"],
        "expected_digest": format!("sha256:{}", metadata["digest"].as_str().unwrap())
    });
    fs::write(
        directory.join("inspection-request.json"),
        serde_json::to_vec(&request).unwrap(),
    )
    .unwrap();
    metadata
}

#[test]
fn signed_archive_crosses_the_real_child_boundary_without_service_configuration() {
    let root = tempfile::tempdir().unwrap();
    let expected = prepare(root.path());
    assert!(invoke(root.path()).success());
    let result: Value =
        serde_json::from_slice(&fs::read(root.path().join("inspection-result.json")).unwrap())
            .unwrap();
    let data = &result["Ok"];
    let raw: [u8; 32] = serde_json::from_value(data["raw_sha256"].clone()).unwrap();
    let canonical: [u8; 32] = serde_json::from_value(data["canonical_sha256"].clone()).unwrap();
    assert_eq!(hex_digest(&raw), expected["digest"]);
    assert_eq!(hex_digest(&canonical), expected["canonical_digest"]);
    assert_eq!(data["manifest"]["id"], "neuro-starter-art");
    assert_eq!(data["signature_key_id"], "local-test-key");
    let signature: SignatureDocument = serde_json::from_value(data["signature"].clone()).unwrap();
    let trusted_key = SigningKey::from_bytes(&[7; 32]).verifying_key().to_bytes();
    verify_signature_digest(canonical, &signature, "local-test-key", &trusted_key).unwrap();
    assert!(verify_signature_digest(canonical, &signature, "local-test-key", &[0; 32]).is_err());
}

#[test]
fn digest_failure_is_typed_and_protocol_errors_do_not_create_results() {
    let root = tempfile::tempdir().unwrap();
    prepare(root.path());
    fs::write(root.path().join("artifact.zip"), b"changed fixture").unwrap();
    assert!(invoke(root.path()).success());
    let result: Value =
        serde_json::from_slice(&fs::read(root.path().join("inspection-result.json")).unwrap())
            .unwrap();
    assert_eq!(result, json!({"Err": "artifact_digest_mismatch"}));
    for request in [b"{".to_vec(), vec![b' '; 64 * 1024 + 1]] {
        let invalid = tempfile::tempdir().unwrap();
        fs::write(invalid.path().join("inspection-request.json"), request).unwrap();
        assert!(!invoke(invalid.path()).success());
        assert!(!invalid.path().join("inspection-result.json").exists());
    }
}
