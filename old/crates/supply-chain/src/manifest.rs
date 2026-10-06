use semver::Version;
use serde_json::Value;
use std::path::Path;

use crate::{ArchiveError, read_zip_entry_file, validate_archive_path, zip_entry_exists_file};

mod art_policy;
mod capability_policy;
mod capability_types;

use art_policy::validate_art_policy;
use capability_policy::validate_capability_policy;

const MAX_MANIFEST_BYTES: u64 = 1024 * 1024;
const MAX_JSON_DEPTH: usize = 32;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PackageKind {
    Art,
    Capability,
    AppUpdate,
}

#[derive(Debug)]
pub struct ExpectedPackage<'a> {
    pub kind: PackageKind,
    pub publisher: &'a str,
    pub package: &'a str,
    pub version: &'a str,
    pub permissions: &'a [String],
}

#[derive(Debug)]
pub struct ValidatedManifest {
    pub document: Value,
    pub manifest_file: &'static str,
    pub signature_file: String,
    pub key_id: String,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ManifestError {
    #[error("package kind is not supported by this scanner")]
    UnsupportedKind,
    #[error("package manifest is invalid")]
    InvalidManifest,
    #[error("package manifest identity does not match the release")]
    IdentityMismatch,
    #[error("package manifest version does not match the release")]
    VersionMismatch,
    #[error("package manifest permissions do not match the release")]
    PermissionMismatch,
    #[error("package entrypoint is unsafe or missing")]
    InvalidEntrypoint,
    #[error("package signature declaration is invalid")]
    InvalidSignature,
    #[error("archive validation failed")]
    Archive(#[from] ArchiveError),
}

pub fn validate_package_manifest(
    archive: &Path,
    expected: &ExpectedPackage<'_>,
) -> Result<ValidatedManifest, ManifestError> {
    match expected.kind {
        PackageKind::Art => validate_art(archive, expected),
        PackageKind::Capability => validate_capability(archive, expected),
        PackageKind::AppUpdate => Err(ManifestError::UnsupportedKind),
    }
}

fn validate_art(
    archive: &Path,
    expected: &ExpectedPackage<'_>,
) -> Result<ValidatedManifest, ManifestError> {
    let document = read_json_entry(archive, "manifest.json")?;
    let runtime = read_json_entry(archive, "art.runtime.json")?;
    require_string(
        &document,
        "/id",
        expected.package,
        ManifestError::IdentityMismatch,
    )?;
    require_string(
        &document,
        "/metadata/packageSecurity/version",
        expected.version,
        ManifestError::VersionMismatch,
    )?;
    require_string(
        &document,
        "/metadata/packageSecurity/publisher/id",
        expected.publisher,
        ManifestError::IdentityMismatch,
    )?;
    let qualified = format!("{}/{}", expected.publisher, expected.package);
    require_string(
        &document,
        "/metadata/art/qualifiedId",
        &qualified,
        ManifestError::IdentityMismatch,
    )?;
    require_string(
        &document,
        "/execution/type",
        "framework_art",
        ManifestError::InvalidManifest,
    )?;
    if runtime.pointer("/protocolVersion").and_then(Value::as_str) != Some("loom.art.runtime.v1") {
        return Err(ManifestError::InvalidManifest);
    }
    validate_art_policy(archive, &document, &runtime, expected)?;
    signature_from(
        archive,
        document,
        "manifest.json",
        "/metadata/packageSecurity/signature",
        "/metadata/packageSecurity/publisher/keyId",
    )
}

fn validate_capability(
    archive: &Path,
    expected: &ExpectedPackage<'_>,
) -> Result<ValidatedManifest, ManifestError> {
    let document = read_json_entry(archive, "capability.manifest.json")?;
    if document.pointer("/schemaVersion").and_then(Value::as_u64) != Some(1)
        || document.pointer("/kind").and_then(Value::as_str) != Some("capability")
    {
        return Err(ManifestError::InvalidManifest);
    }
    require_string(
        &document,
        "/id",
        expected.package,
        ManifestError::IdentityMismatch,
    )?;
    require_string(
        &document,
        "/publisher/id",
        expected.publisher,
        ManifestError::IdentityMismatch,
    )?;
    require_string(
        &document,
        "/version",
        expected.version,
        ManifestError::VersionMismatch,
    )?;
    Version::parse(expected.version).map_err(|_| ManifestError::VersionMismatch)?;
    validate_capability_policy(archive, &document, expected)?;
    signature_from(
        archive,
        document,
        "capability.manifest.json",
        "/signature",
        "/publisher/keyId",
    )
}

fn read_json_entry(archive: &Path, name: &str) -> Result<Value, ManifestError> {
    let bytes = read_zip_entry_file(archive, name, MAX_MANIFEST_BYTES)?;
    let document: Value =
        serde_json::from_slice(&bytes).map_err(|_| ManifestError::InvalidManifest)?;
    if json_depth(&document) > MAX_JSON_DEPTH || !document.is_object() {
        return Err(ManifestError::InvalidManifest);
    }
    Ok(document)
}

fn signature_from(
    archive: &Path,
    document: Value,
    manifest_file: &'static str,
    signature_pointer: &str,
    publisher_key_pointer: &str,
) -> Result<ValidatedManifest, ManifestError> {
    let signature = document
        .pointer(signature_pointer)
        .and_then(Value::as_object)
        .ok_or(ManifestError::InvalidSignature)?;
    let algorithm = signature.get("algorithm").and_then(Value::as_str);
    let key_id = signature
        .get("keyId")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let file = signature
        .get("file")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if algorithm != Some("ed25519")
        || key_id.is_empty()
        || !validate_archive_path(file)
        || document
            .pointer(publisher_key_pointer)
            .and_then(Value::as_str)
            != Some(key_id)
    {
        return Err(ManifestError::InvalidSignature);
    }
    if !zip_entry_exists_file(archive, file)? {
        return Err(ManifestError::InvalidSignature);
    }
    let signature_file = file.to_owned();
    let key_id = key_id.to_owned();
    Ok(ValidatedManifest {
        document,
        manifest_file,
        signature_file,
        key_id,
    })
}

fn require_string(
    document: &Value,
    pointer: &str,
    expected: &str,
    error: ManifestError,
) -> Result<(), ManifestError> {
    (document.pointer(pointer).and_then(Value::as_str) == Some(expected))
        .then_some(())
        .ok_or(error)
}

fn json_depth(value: &Value) -> usize {
    match value {
        Value::Array(values) => 1 + values.iter().map(json_depth).max().unwrap_or(0),
        Value::Object(values) => 1 + values.values().map(json_depth).max().unwrap_or(0),
        _ => 1,
    }
}
