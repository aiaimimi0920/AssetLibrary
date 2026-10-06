use semver::VersionReq;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;

use super::{ExpectedPackage, ManifestError};
use crate::{validate_archive_path, zip_entry_exists_file};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtRuntime {
    protocol_version: String,
    entry: RuntimeEntry,
    #[serde(default)]
    limits: Option<RuntimeLimits>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RuntimeEntry {
    command: String,
    #[serde(default)]
    args: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RuntimeLimits {
    timeout_ms: u64,
    max_stdout_bytes: u64,
    max_stderr_bytes: u64,
    max_processes: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtManifestShape {
    #[serde(rename = "id")]
    _id: String,
    #[serde(rename = "name")]
    _name: String,
    #[serde(rename = "description")]
    _description: String,
    #[serde(rename = "enabled")]
    _enabled: bool,
    #[serde(rename = "execution")]
    _execution: ArtExecutionShape,
    inputs: Vec<Value>,
    outputs: Vec<Value>,
    params: Vec<Value>,
    #[serde(rename = "metadata")]
    _metadata: ArtMetadataShape,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtExecutionShape {
    #[serde(rename = "type")]
    _kind: String,
    #[serde(rename = "framework")]
    _framework: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtMetadataShape {
    #[serde(rename = "packageSecurity")]
    _package_security: PackageSecurityShape,
    #[serde(rename = "art")]
    _art: ArtIdentityShape,
    #[serde(rename = "dependencies")]
    _dependencies: DependenciesShape,
    #[serde(default, rename = "capabilities")]
    _capabilities: Option<BTreeMap<String, Value>>,
    #[serde(default, rename = "localization")]
    _localization: Option<BTreeMap<String, Value>>,
    #[serde(default, rename = "marketData")]
    _market_data: Option<BTreeMap<String, Value>>,
    #[serde(default, rename = "mcp")]
    _mcp: Option<BTreeMap<String, Value>>,
    #[serde(default, rename = "cloud")]
    _cloud: Option<BTreeMap<String, Value>>,
    #[serde(default, rename = "plugin")]
    _plugin: Option<BTreeMap<String, Value>>,
    #[serde(default, rename = "python")]
    _python: Option<BTreeMap<String, Value>>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageSecurityShape {
    #[serde(rename = "version")]
    _version: String,
    #[serde(rename = "publisher")]
    _publisher: PublisherShape,
    #[serde(rename = "signature")]
    _signature: SignatureShape,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PublisherShape {
    #[serde(rename = "id")]
    _id: String,
    #[serde(rename = "keyId")]
    _key_id: String,
    #[serde(default, rename = "name")]
    _name: Option<String>,
    #[serde(default, rename = "icon")]
    _icon: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SignatureShape {
    #[serde(rename = "algorithm")]
    _algorithm: String,
    #[serde(rename = "keyId")]
    _key_id: String,
    #[serde(rename = "file")]
    _file: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ArtIdentityShape {
    #[serde(rename = "qualifiedId")]
    _qualified_id: String,
    #[serde(default, rename = "englishName")]
    _english_name: Option<String>,
    #[serde(default, rename = "globalId")]
    _global_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DependenciesShape {
    #[serde(rename = "framework")]
    _framework: String,
    #[serde(default, rename = "frameworkVersion")]
    _framework_version: Option<String>,
    #[serde(default, rename = "mcpServers")]
    _mcp_servers: Vec<McpDependencyShape>,
    #[serde(default, rename = "arts")]
    _arts: Vec<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct McpDependencyShape {
    #[serde(rename = "id")]
    _id: String,
    #[serde(rename = "version")]
    _version: String,
}

pub(super) fn validate_art_policy(
    archive: &Path,
    document: &Value,
    runtime: &Value,
    expected: &ExpectedPackage<'_>,
) -> Result<(), ManifestError> {
    let shape: ArtManifestShape =
        serde_json::from_value(document.clone()).map_err(|_| ManifestError::InvalidManifest)?;
    if shape.inputs.len() > 256 || shape.outputs.len() > 256 || shape.params.len() > 256 {
        return Err(ManifestError::InvalidManifest);
    }
    if !expected.permissions.is_empty() {
        return Err(ManifestError::PermissionMismatch);
    }
    let id = text(document, "/id")?;
    let name = text(document, "/name")?;
    let description = text(document, "/description")?;
    let framework = text(document, "/execution/framework")?;
    let dependency_framework = text(document, "/metadata/dependencies/framework")?;
    if !safe_id(id)
        || name.is_empty()
        || name.len() > 128
        || description.len() > 4096
        || document
            .pointer("/enabled")
            .and_then(Value::as_bool)
            .is_none()
        || !safe_reference(framework)
        || dependency_framework != framework
    {
        return Err(ManifestError::InvalidManifest);
    }
    if let Some(requirement) = document
        .pointer("/metadata/dependencies/frameworkVersion")
        .and_then(Value::as_str)
        && (requirement.len() > 128 || VersionReq::parse(requirement).is_err())
    {
        return Err(ManifestError::InvalidManifest);
    }
    validate_mcp_dependencies(document)?;
    validate_runtime(archive, runtime)?;
    validate_surface(archive, document)?;
    Ok(())
}

fn validate_runtime(archive: &Path, document: &Value) -> Result<(), ManifestError> {
    let runtime: ArtRuntime =
        serde_json::from_value(document.clone()).map_err(|_| ManifestError::InvalidManifest)?;
    if runtime.protocol_version != "loom.art.runtime.v1"
        || runtime.entry.command.len() > 1024
        || !validate_archive_path(&runtime.entry.command)
        || runtime.entry.args.len() > 64
        || runtime
            .entry
            .args
            .iter()
            .any(|argument| argument.len() > 4096 || argument.contains(['\0', '\r', '\n']))
    {
        return Err(ManifestError::InvalidEntrypoint);
    }
    let packaged_command = runtime.entry.command.contains('/');
    if packaged_command {
        require_entry(archive, &runtime.entry.command)?;
    }
    let mut packaged_argument = false;
    for argument in &runtime.entry.args {
        if argument.starts_with("runtime/") {
            require_entry(archive, argument)?;
            packaged_argument = true;
        }
    }
    if !packaged_command && !packaged_argument {
        return Err(ManifestError::InvalidEntrypoint);
    }
    if runtime.limits.is_some_and(|limits| {
        !(1..=120_000).contains(&limits.timeout_ms)
            || !(1..=64 * 1024 * 1024).contains(&limits.max_stdout_bytes)
            || !(1..=16 * 1024 * 1024).contains(&limits.max_stderr_bytes)
            || !(1..=16).contains(&limits.max_processes)
    }) {
        return Err(ManifestError::InvalidManifest);
    }
    Ok(())
}

fn validate_mcp_dependencies(document: &Value) -> Result<(), ManifestError> {
    let Some(servers) = document
        .pointer("/metadata/dependencies/mcpServers")
        .and_then(Value::as_array)
    else {
        return Ok(());
    };
    if servers.len() > 64 {
        return Err(ManifestError::InvalidManifest);
    }
    for server in servers {
        let id = server.get("id").and_then(Value::as_str).unwrap_or_default();
        let version = server
            .get("version")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if !safe_reference(id) || VersionReq::parse(version).is_err() {
            return Err(ManifestError::InvalidManifest);
        }
    }
    Ok(())
}

fn validate_surface(archive: &Path, document: &Value) -> Result<(), ManifestError> {
    let Some(surface) = document.pointer("/metadata/capabilities/surface") else {
        return Ok(());
    };
    if surface.pointer("/protocolVersion").and_then(Value::as_str) != Some("loom.surface.v1")
        || surface.pointer("/apiVersion").and_then(Value::as_str) != Some("1.0")
    {
        return Err(ManifestError::InvalidManifest);
    }
    let variants = surface
        .get("variants")
        .and_then(Value::as_array)
        .filter(|variants| !variants.is_empty() && variants.len() <= 8)
        .ok_or(ManifestError::InvalidManifest)?;
    for variant in variants {
        let entry = variant
            .get("entry")
            .and_then(Value::as_str)
            .ok_or(ManifestError::InvalidEntrypoint)?;
        require_entry(archive, entry)?;
    }
    if let Some(fallback) = surface.get("fallbackScene").and_then(Value::as_str) {
        require_entry(archive, fallback)?;
    }
    Ok(())
}

fn text<'a>(document: &'a Value, pointer: &str) -> Result<&'a str, ManifestError> {
    document
        .pointer(pointer)
        .and_then(Value::as_str)
        .ok_or(ManifestError::InvalidManifest)
}

fn require_entry(archive: &Path, path: &str) -> Result<(), ManifestError> {
    if !validate_archive_path(path) || !zip_entry_exists_file(archive, path)? {
        return Err(ManifestError::InvalidEntrypoint);
    }
    Ok(())
}

fn safe_reference(value: &str) -> bool {
    let mut segments = value.split('/');
    let first = segments.next().is_some_and(safe_id);
    let second = segments.next();
    first && second.is_none_or(safe_id) && segments.next().is_none()
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'-' | b'_' | b'.')
        })
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !value.contains("..")
}
