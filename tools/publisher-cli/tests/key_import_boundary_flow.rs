use assert_cmd::Command;
use serde_json::Value;
use std::{fs, path::PathBuf};
use tempfile::TempDir;

struct Fixture {
    _directory: TempDir,
    source: PathBuf,
    private_key: PathBuf,
    output: PathBuf,
}

fn decode_hex(value: &Value) -> Vec<u8> {
    value
        .as_str()
        .unwrap()
        .as_bytes()
        .chunks_exact(2)
        .map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
        .collect()
}

fn command(subcommand: &str) -> Command {
    let mut command = Command::cargo_bin("assetlibrary-publisher").unwrap();
    command.args([
        "--json",
        subcommand,
        "--kind",
        "art",
        "--publisher",
        "synthetic",
        "--package",
        "key-compatibility",
        "--version",
        "1.0.0",
        "--key-id",
        "test-key",
    ]);
    command
}

impl Fixture {
    fn new() -> Self {
        let directory = TempDir::new().unwrap();
        let source = directory.path().join("source");
        let private_key = directory.path().join("public-synthetic.pem");
        let output = directory.path().join("never-persisted.zip");
        command("manifest")
            .arg("--output-dir")
            .arg(&source)
            .assert()
            .success();
        fs::create_dir_all(source.join("runtime")).unwrap();
        fs::write(source.join("runtime/main.exe"), b"synthetic runtime").unwrap();
        Self {
            _directory: directory,
            source,
            private_key,
            output,
        }
    }

    fn check(&self, pem: &[u8], accepted: bool, label: &str) {
        fs::write(&self.private_key, pem).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.private_key, fs::Permissions::from_mode(0o600)).unwrap();
        }
        let result = command("pack")
            .arg("--source")
            .arg(&self.source)
            .arg("--private-key")
            .arg(&self.private_key)
            .arg("--output")
            .arg(&self.output)
            .args(["--executable", "runtime/main.exe", "--dry-run"])
            .output()
            .unwrap();
        assert_eq!(
            result.status.success(),
            accepted,
            "{label}: unexpected import outcome"
        );
        if !accepted {
            assert_eq!(result.status.code(), Some(1), "{label}");
            assert!(
                result.stdout.is_empty(),
                "{label}: rejected import emitted output"
            );
            assert_eq!(
                result.stderr, b"error: package signing key is invalid\n",
                "{label}: error must not expose key bytes"
            );
        } else {
            let output: Value = serde_json::from_slice(&result.stdout).unwrap();
            assert_eq!(output["dry_run"], true, "{label}");
        }
        assert!(
            !self.output.exists(),
            "dry run or rejected key must not persist an archive"
        );
    }
}

#[test]
fn pkcs8_public_bitstrings_and_attributes_follow_explicit_import_policy() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/pkcs8-boundaries-v1.json"
    ))
    .unwrap();
    let cases = data["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 26);
    let fixture = Fixture::new();
    for case in cases {
        for ending in ["lf", "crlf"] {
            fixture.check(
                &decode_hex(&case[format!("pem_{ending}_hex")]),
                case["expected_cli_accepted"].as_bool().unwrap(),
                &format!("{}/{ending}", case["id"].as_str().unwrap()),
            );
        }
    }
}

#[test]
fn original_pem_whitespace_and_label_behavior_survives_import_guard() {
    let data: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/ed25519-compatibility-v1.json"
    ))
    .unwrap();
    let cases = data["pem"].as_array().unwrap();
    assert_eq!(cases.len(), 8);
    let fixture = Fixture::new();
    for case in cases {
        let pem = decode_hex(&case["input_utf8_hex"]);
        fixture.check(
            &pem,
            case["accepted"].as_bool().unwrap(),
            case["id"].as_str().unwrap(),
        );
    }
}
