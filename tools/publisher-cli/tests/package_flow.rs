use assert_cmd::Command;
use assetlibrary_supply_chain::{hex_digest, sha256_digest};
use ed25519_dalek::{SigningKey, pkcs8::EncodePrivateKey};
use pkcs8::LineEnding;
use serde_json::Value;
use std::{fs, path::Path};
use tempfile::TempDir;

const PUBLISHER: &str = "publisher.example";
const PACKAGE: &str = "sample-art";
const VERSION: &str = "1.2.3";
const KEY_ID: &str = "release-1";

#[test]
fn manifest_pack_digest_and_validate_round_trip() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    let private_key = temp.path().join("private.pem");
    let public_key = temp.path().join("public.txt");
    let archive = temp.path().join("sample.zip");
    let second_archive = temp.path().join("sample-copy.zip");
    let dry_run_archive = temp.path().join("dry-run.zip");
    write_private_key(&private_key);

    let manifest = manifest_command(&source)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(parse(&manifest)["command"], "manifest");
    fs::create_dir_all(source.join("runtime")).unwrap();
    fs::write(source.join("runtime/main.exe"), b"test-runtime").unwrap();

    let before = fs::read(source.join("manifest.json")).unwrap();
    manifest_command(&source).assert().failure().code(6);
    assert_eq!(fs::read(source.join("manifest.json")).unwrap(), before);

    pack_command(&source, &private_key, &dry_run_archive)
        .arg("--dry-run")
        .assert()
        .success();
    assert!(!dry_run_archive.exists());

    let packed = pack_command(&source, &private_key, &archive)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let packed = parse(&packed);
    let golden: Value = serde_json::from_str(include_str!(
        "../../../fixtures/crypto/compatibility-v1.json"
    ))
    .unwrap();
    assert_eq!(packed["fingerprint"], golden["signature"]["fingerprint"]);
    assert_eq!(
        packed["public_key_base64"],
        golden["signature"]["public_key_base64"]
    );
    assert_eq!(
        hex_digest(&sha256_digest(&fs::read(&private_key).unwrap())),
        golden["signature"]["pkcs8_pem_lf_sha256_hex"]
    );
    assert_eq!(packed["artifact"]["manifest_file"], "manifest.json");
    assert_ne!(
        packed["artifact"]["archive_sha256"],
        packed["artifact"]["canonical_sha256"]
    );
    fs::write(&public_key, packed["public_key_base64"].as_str().unwrap()).unwrap();
    // Both conventional PEM line endings must load the same signing key.
    let pem_crlf = SigningKey::from_bytes(&[7; 32])
        .to_pkcs8_pem(LineEnding::CRLF)
        .unwrap();
    assert_eq!(
        hex_digest(&sha256_digest(pem_crlf.as_bytes())),
        golden["signature"]["pkcs8_pem_crlf_sha256_hex"]
    );
    fs::write(&private_key, pem_crlf.as_bytes()).unwrap();
    pack_command(&source, &private_key, &second_archive)
        .assert()
        .success();
    assert_eq!(
        fs::read(&archive).unwrap(),
        fs::read(second_archive).unwrap()
    );

    let validated = base_command("validate")
        .args(identity_args())
        .arg("--archive")
        .arg(&archive)
        .arg("--public-key")
        .arg(&public_key)
        .arg("--key-id")
        .arg(KEY_ID)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(parse(&validated)["valid"], true);

    let digested = base_command("digest")
        .arg("--archive")
        .arg(&archive)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        parse(&digested)["archive_sha256"],
        packed["artifact"]["archive_sha256"]
    );
}

#[test]
fn pack_rejects_a_private_key_inside_the_source() {
    let temp = TempDir::new().unwrap();
    let source = temp.path().join("source");
    let archive = temp.path().join("sample.zip");
    manifest_command(&source).assert().success();
    fs::create_dir_all(source.join("runtime")).unwrap();
    fs::write(source.join("runtime/main.exe"), b"test-runtime").unwrap();
    let private_key = source.join("private.pem");
    write_private_key(&private_key);

    pack_command(&source, &private_key, &archive)
        .assert()
        .failure()
        .code(4);
    assert!(!archive.exists());
}

fn manifest_command(output: &Path) -> Command {
    let mut command = base_command("manifest");
    command
        .args(identity_args())
        .arg("--key-id")
        .arg(KEY_ID)
        .arg("--output-dir")
        .arg(output);
    command
}

fn pack_command(source: &Path, private_key: &Path, output: &Path) -> Command {
    let mut command = base_command("pack");
    command
        .args(identity_args())
        .arg("--source")
        .arg(source)
        .arg("--output")
        .arg(output)
        .arg("--private-key")
        .arg(private_key)
        .arg("--key-id")
        .arg(KEY_ID)
        .arg("--executable")
        .arg("runtime/main.exe");
    command
}

fn base_command(subcommand: &str) -> Command {
    let mut command = Command::cargo_bin("assetlibrary-publisher").unwrap();
    command.arg("--json").arg(subcommand);
    command
}

fn identity_args() -> [&'static str; 8] {
    [
        "--kind",
        "art",
        "--publisher",
        PUBLISHER,
        "--package",
        PACKAGE,
        "--version",
        VERSION,
    ]
}

fn parse(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}

fn write_private_key(path: &Path) {
    let key = SigningKey::from_bytes(&[7; 32]);
    let pem = key.to_pkcs8_pem(LineEnding::LF).unwrap();
    fs::write(path, pem.as_bytes()).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600)).unwrap();
    }
}
