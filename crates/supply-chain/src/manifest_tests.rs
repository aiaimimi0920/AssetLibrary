use crate::{ExpectedPackage, ManifestError, PackageKind, validate_package_manifest};
use serde_json::json;
use std::{fs::File, io::Write};
use tempfile::TempDir;
use zip::{ZipWriter, write::SimpleFileOptions};

fn write_archive(entries: Vec<(&str, Vec<u8>)>) -> (TempDir, std::path::PathBuf) {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("package.zip");
    let mut writer = ZipWriter::new(File::create(&path).unwrap());
    for (name, bytes) in entries {
        writer
            .start_file(name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(&bytes).unwrap();
    }
    writer.finish().unwrap();
    (directory, path)
}

fn capability_manifest() -> serde_json::Value {
    json!({
        "schemaVersion": 1,
        "kind": "capability",
        "id": "text-tools",
        "name": "Text Tools",
        "description": "Adds bounded text commands.",
        "version": "1.0.0",
        "publisher": {"id": "publisher", "keyId": "release-1"},
        "hostCompatibility": {
            "loomCapabilityApi": {"minimum": "1.0"},
            "hookExtensionApi": {"minimum": "1.0"}
        },
        "entrypoints": {"service": {
            "targets": {"windows-x64": {"command": "runtime/text-tools.exe"}},
            "processModel": "on_demand"
        }},
        "activationEvents": ["onCommand:publisher/text-tools.transform"],
        "contributes": {"commands": [{
            "id": "publisher/text-tools.transform",
            "title": "Transform text",
            "permissions": ["hook.selection.read"]
        }]},
        "permissions": ["hook.selection.read"],
        "resources": {
            "memoryMiB": 128,
            "maxProcesses": 1,
            "timeoutSeconds": 30,
            "diskMib": 256,
            "stderrKibPerMinute": 64
        },
        "dependencies": [],
        "signature": {"algorithm": "ed25519", "keyId": "release-1", "file": "signature.json"}
    })
}

fn validate_capability(
    manifest: &serde_json::Value,
    permissions: &[String],
) -> Result<(), ManifestError> {
    let (_directory, archive) = write_archive(vec![
        (
            "capability.manifest.json",
            serde_json::to_vec(manifest).unwrap(),
        ),
        ("runtime/text-tools.exe", b"payload".to_vec()),
        ("signature.json", b"signature".to_vec()),
    ]);
    validate_package_manifest(
        &archive,
        &ExpectedPackage {
            kind: PackageKind::Capability,
            publisher: "publisher",
            package: "text-tools",
            version: "1.0.0",
            permissions,
        },
    )
    .map(|_| ())
}

#[test]
fn validates_art_identity_runtime_and_signature_declaration() {
    let manifest = json!({
        "id": "starter-art",
        "name": "Starter Art",
        "description": "A bounded Art package.",
        "enabled": true,
        "execution": {"type": "framework_art", "framework": "neuro/runtime"},
        "inputs": [],
        "outputs": [],
        "params": [],
        "metadata": {
            "art": {"qualifiedId": "publisher/starter-art"},
            "dependencies": {"framework": "neuro/runtime", "frameworkVersion": "^1.0"},
            "packageSecurity": {
                "version": "1.0.0",
                "publisher": {"id": "publisher", "keyId": "release-1"},
                "signature": {"algorithm": "ed25519", "keyId": "release-1", "file": "signature.json"}
            }
        }
    });
    let runtime = json!({
        "protocolVersion": "loom.art.runtime.v1",
        "entry": {"command": "runtime/main.exe"}
    });
    let (_directory, archive) = write_archive(vec![
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("art.runtime.json", serde_json::to_vec(&runtime).unwrap()),
        ("runtime/main.exe", b"payload".to_vec()),
        ("signature.json", b"signature".to_vec()),
    ]);
    let expected = ExpectedPackage {
        kind: PackageKind::Art,
        publisher: "publisher",
        package: "starter-art",
        version: "1.0.0",
        permissions: &[],
    };
    let validated = validate_package_manifest(&archive, &expected).unwrap();
    assert_eq!(validated.key_id, "release-1");
    assert_eq!(validated.signature_file, "signature.json");
}

#[test]
fn art_rejects_undeclared_root_and_security_fields() {
    let manifest = json!({
        "id": "starter-art",
        "name": "Starter Art",
        "description": "A bounded Art package.",
        "enabled": true,
        "execution": {"type": "framework_art", "framework": "neuro/runtime"},
        "inputs": [], "outputs": [], "params": [],
        "permissions": ["network"],
        "metadata": {
            "art": {"qualifiedId": "publisher/starter-art"},
            "dependencies": {"framework": "neuro/runtime"},
            "packageSecurity": {
                "version": "1.0.0",
                "publisher": {"id": "publisher", "keyId": "release-1"},
                "signature": {"algorithm": "ed25519", "keyId": "release-1", "file": "signature.json"}
            }
        }
    });
    let runtime = json!({
        "protocolVersion": "loom.art.runtime.v1",
        "entry": {"command": "runtime/main.exe"}
    });
    let (_directory, archive) = write_archive(vec![
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("art.runtime.json", serde_json::to_vec(&runtime).unwrap()),
        ("runtime/main.exe", b"payload".to_vec()),
        ("signature.json", b"signature".to_vec()),
    ]);
    let expected = ExpectedPackage {
        kind: PackageKind::Art,
        publisher: "publisher",
        package: "starter-art",
        version: "1.0.0",
        permissions: &[],
    };
    assert_eq!(
        validate_package_manifest(&archive, &expected).unwrap_err(),
        ManifestError::InvalidManifest
    );
}

#[test]
fn art_accepts_host_commands_only_with_packaged_entry_and_rejects_permissions() {
    let manifest = json!({
        "id": "starter-art",
        "name": "Starter Art",
        "description": "A script-backed Art package.",
        "enabled": true,
        "execution": {"type": "framework_art", "framework": "neuro/runtime"},
        "inputs": [],
        "outputs": [],
        "params": [],
        "metadata": {
            "art": {"qualifiedId": "publisher/starter-art"},
            "dependencies": {"framework": "neuro/runtime"},
            "packageSecurity": {
                "version": "1.0.0",
                "publisher": {"id": "publisher", "keyId": "release-1"},
                "signature": {"algorithm": "ed25519", "keyId": "release-1", "file": "signature.json"}
            }
        }
    });
    let runtime = json!({
        "protocolVersion": "loom.art.runtime.v1",
        "entry": {
            "command": "powershell.exe",
            "args": ["-NoProfile", "-File", "runtime/main.ps1"]
        },
        "limits": {
            "timeoutMs": 30000,
            "maxStdoutBytes": 1048576,
            "maxStderrBytes": 262144,
            "maxProcesses": 1
        }
    });
    let (_directory, archive) = write_archive(vec![
        ("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("art.runtime.json", serde_json::to_vec(&runtime).unwrap()),
        ("runtime/main.ps1", b"exit 0".to_vec()),
        ("signature.json", b"signature".to_vec()),
    ]);
    let mut expected = ExpectedPackage {
        kind: PackageKind::Art,
        publisher: "publisher",
        package: "starter-art",
        version: "1.0.0",
        permissions: &[],
    };
    assert!(validate_package_manifest(&archive, &expected).is_ok());
    let permissions = vec!["hook.selection.read".to_owned()];
    expected.permissions = &permissions;
    assert_eq!(
        validate_package_manifest(&archive, &expected).unwrap_err(),
        ManifestError::PermissionMismatch
    );
}

#[test]
fn capability_permissions_are_bound_to_release_metadata() {
    let manifest = capability_manifest();
    let expected_permissions = vec!["hook.selection.read".to_owned()];
    assert!(validate_capability(&manifest, &expected_permissions).is_ok());
    assert_eq!(
        validate_capability(&manifest, &[]).unwrap_err(),
        ManifestError::PermissionMismatch
    );
}

#[test]
fn capability_rejects_unknown_permissions_and_unbounded_resources() {
    let mut manifest = capability_manifest();
    manifest["permissions"] = json!(["hook.filesystem.unrestricted"]);
    manifest["contributes"]["commands"][0]["permissions"] = json!([]);
    let permissions = vec!["hook.filesystem.unrestricted".to_owned()];
    assert_eq!(
        validate_capability(&manifest, &permissions).unwrap_err(),
        ManifestError::PermissionMismatch
    );

    let mut manifest = capability_manifest();
    manifest["resources"]["memoryMiB"] = json!(8192);
    let permissions = vec!["hook.selection.read".to_owned()];
    assert_eq!(
        validate_capability(&manifest, &permissions).unwrap_err(),
        ManifestError::InvalidManifest
    );
}

#[test]
fn capability_rejects_incompatible_hosts_and_undeclared_command_permissions() {
    let permissions = vec!["hook.selection.read".to_owned()];
    let mut manifest = capability_manifest();
    manifest["hostCompatibility"]["loomCapabilityApi"]["minimum"] = json!("2.0");
    assert_eq!(
        validate_capability(&manifest, &permissions).unwrap_err(),
        ManifestError::InvalidManifest
    );

    let mut manifest = capability_manifest();
    manifest["contributes"]["commands"][0]["permissions"] = json!(["hook.notice.show"]);
    assert_eq!(
        validate_capability(&manifest, &permissions).unwrap_err(),
        ManifestError::InvalidManifest
    );
}

#[test]
fn capability_requires_referenced_schema_files() {
    let mut manifest = capability_manifest();
    manifest["contributes"]["commands"][0]["inputSchema"] = json!("schemas/input.json");
    let permissions = vec!["hook.selection.read".to_owned()];
    assert_eq!(
        validate_capability(&manifest, &permissions).unwrap_err(),
        ManifestError::InvalidEntrypoint
    );
}
