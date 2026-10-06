use semver::{Version, VersionReq};
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

use super::capability_types::{
    ApiRequirement, CapabilityManifest, CommandContribution, Contribution, Contributions,
};
use super::{ExpectedPackage, ManifestError};
use crate::{validate_archive_path, zip_entry_exists_file};

pub(super) fn validate_capability_policy(
    archive: &Path,
    document: &Value,
    expected: &ExpectedPackage<'_>,
) -> Result<(), ManifestError> {
    let manifest: CapabilityManifest =
        serde_json::from_value(document.clone()).map_err(|_| ManifestError::InvalidManifest)?;
    if manifest.schema_version != 1
        || manifest.kind != "capability"
        || manifest.id != expected.package
        || manifest.publisher.id != expected.publisher
        || manifest.version != expected.version
        || !safe_id(&manifest.id)
        || !safe_id(&manifest.publisher.id)
        || manifest.name.is_empty()
        || manifest.name.len() > 128
        || manifest.description.len() > 4096
        || Version::parse(&manifest.version).is_err()
    {
        return Err(ManifestError::InvalidManifest);
    }
    validate_host(&manifest)?;
    validate_permissions(&manifest.permissions, expected.permissions)?;
    validate_entrypoints(archive, &manifest)?;
    validate_resources(&manifest)?;
    validate_activation_events(&manifest.activation_events)?;
    validate_contributions(archive, &manifest)?;
    validate_dependencies(&manifest)?;
    if manifest.signature.algorithm != "ed25519"
        || manifest.signature.key_id != manifest.publisher.key_id
        || !validate_archive_path(&manifest.signature.file)
    {
        return Err(ManifestError::InvalidSignature);
    }
    Ok(())
}

fn validate_host(manifest: &CapabilityManifest) -> Result<(), ManifestError> {
    validate_api_requirement(&manifest.host_compatibility.loom_capability_api)?;
    validate_api_requirement(&manifest.host_compatibility.hook_extension_api)?;
    if let Some(requirement) = &manifest.host_compatibility.surface_api {
        validate_api_requirement(requirement)?;
    }
    Ok(())
}

fn validate_api_requirement(requirement: &ApiRequirement) -> Result<(), ManifestError> {
    for version in std::iter::once(&requirement.minimum).chain(requirement.maximum.iter()) {
        let valid = version
            .split_once('.')
            .is_some_and(|(major, minor)| major == "1" && minor.parse::<u32>().is_ok());
        if !valid {
            return Err(ManifestError::InvalidManifest);
        }
    }
    for features in [
        &requirement.required_features,
        &requirement.optional_features,
    ] {
        let unique = features.iter().collect::<HashSet<_>>();
        if features.len() > 128
            || unique.len() != features.len()
            || features
                .iter()
                .any(|feature| feature.is_empty() || feature.len() > 128)
        {
            return Err(ManifestError::InvalidManifest);
        }
    }
    Ok(())
}

fn validate_entrypoints(
    archive: &Path,
    manifest: &CapabilityManifest,
) -> Result<(), ManifestError> {
    if manifest.entrypoints.service.is_none() && manifest.entrypoints.hook_ui.is_none() {
        return Err(ManifestError::InvalidEntrypoint);
    }
    if let Some(service) = &manifest.entrypoints.service {
        if service.targets.is_empty()
            || service.targets.len() > 16
            || !matches!(service.process_model.as_str(), "on_demand" | "persistent")
        {
            return Err(ManifestError::InvalidEntrypoint);
        }
        for (platform, target) in &service.targets {
            if !valid_platform(platform)
                || target.args.len() > 64
                || target.args.iter().any(|argument| argument.len() > 4096)
            {
                return Err(ManifestError::InvalidEntrypoint);
            }
            require_archive_entry(archive, &target.command)?;
        }
    }
    if let Some(surface) = &manifest.entrypoints.hook_ui {
        if surface.kind != "surface" {
            return Err(ManifestError::InvalidEntrypoint);
        }
        require_archive_entry(archive, &surface.manifest)?;
    }
    Ok(())
}

fn validate_resources(manifest: &CapabilityManifest) -> Result<(), ManifestError> {
    let resources = &manifest.resources;
    if !(16..=4096).contains(&resources.memory_mib)
        || !(1..=16).contains(&resources.max_processes)
        || !(1..=120).contains(&resources.timeout_seconds)
        || resources
            .disk_mib
            .is_some_and(|value| !(1..=2048).contains(&value))
        || resources
            .stderr_kib_per_minute
            .is_some_and(|value| !(1..=256).contains(&value))
    {
        return Err(ManifestError::InvalidManifest);
    }
    Ok(())
}

fn validate_activation_events(events: &[String]) -> Result<(), ManifestError> {
    let unique = events
        .iter()
        .map(|value| value.to_ascii_lowercase())
        .collect::<HashSet<_>>();
    if events.len() > 256
        || unique.len() != events.len()
        || events
            .iter()
            .any(|event| event.is_empty() || event.len() > 256)
    {
        return Err(ManifestError::InvalidManifest);
    }
    Ok(())
}

fn validate_contributions(
    archive: &Path,
    manifest: &CapabilityManifest,
) -> Result<(), ManifestError> {
    let contributions = &manifest.contributes;
    if contributions.commands.len() > 128 {
        return Err(ManifestError::InvalidManifest);
    }
    let namespace = format!("{}/{}.", manifest.publisher.id, manifest.id);
    let declared = manifest
        .permissions
        .iter()
        .map(String::as_str)
        .collect::<HashSet<_>>();
    let mut seen = HashSet::new();
    let mut commands = HashSet::new();
    for command in &contributions.commands {
        validate_command(archive, command, &namespace, &declared, &mut seen)?;
        commands.insert(command.id.to_ascii_lowercase());
    }
    for (values, maximum) in generic_lists(contributions) {
        if values.len() > maximum {
            return Err(ManifestError::InvalidManifest);
        }
        for contribution in values {
            validate_contribution(archive, contribution, &namespace, &mut seen)?;
            if contribution
                .command
                .as_ref()
                .is_some_and(|command| !commands.contains(&command.to_ascii_lowercase()))
            {
                return Err(ManifestError::InvalidManifest);
            }
        }
    }
    for setting in &contributions.settings {
        validate_setting(setting)?;
    }
    Ok(())
}

fn validate_command(
    archive: &Path,
    command: &CommandContribution,
    namespace: &str,
    declared: &HashSet<&str>,
    seen: &mut HashSet<String>,
) -> Result<(), ManifestError> {
    validate_contribution_id(&command.id, namespace, seen)?;
    if command.title.is_empty()
        || command.title.len() > 128
        || command.description.len() > 1024
        || command
            .when
            .as_ref()
            .is_some_and(|value| value.len() > 2048)
        || command
            .timeout_ms
            .is_some_and(|value| !(1..=120_000).contains(&value))
        || command.permissions.len() > 32
        || command.permissions.iter().any(|permission| {
            !valid_permission(permission) || !declared.contains(permission.as_str())
        })
    {
        return Err(ManifestError::InvalidManifest);
    }
    let _ = (command.requires_user_gesture, command.cancellable);
    for path in [&command.input_schema, &command.output_schema]
        .into_iter()
        .flatten()
    {
        require_archive_entry(archive, path)?;
    }
    Ok(())
}

fn validate_contribution(
    archive: &Path,
    contribution: &Contribution,
    namespace: &str,
    seen: &mut HashSet<String>,
) -> Result<(), ManifestError> {
    validate_contribution_id(&contribution.id, namespace, seen)?;
    if contribution
        .command
        .as_ref()
        .is_some_and(|value| !valid_qualified_id(value, namespace))
        || contribution
            .title
            .as_ref()
            .is_some_and(|value| value.len() > 128)
        || contribution
            .when
            .as_ref()
            .is_some_and(|value| value.len() > 2048)
        || contribution
            .placement
            .as_ref()
            .is_some_and(|value| value.len() > 128)
        || contribution
            .order
            .is_some_and(|value| !(-10_000..=10_000).contains(&value))
    {
        return Err(ManifestError::InvalidManifest);
    }
    if let Some(path) = &contribution.schema {
        require_archive_entry(archive, path)?;
    }
    Ok(())
}

fn validate_setting(setting: &Contribution) -> Result<(), ManifestError> {
    let payload = setting
        .payload
        .as_object()
        .ok_or(ManifestError::InvalidManifest)?;
    let kind = payload
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let default = payload.get("default");
    let valid = match kind {
        "string" => default.is_none_or(Value::is_string),
        "number" => default.is_none_or(Value::is_number),
        "boolean" => default.is_none_or(Value::is_boolean),
        "json" => true,
        "enum" => payload
            .get("options")
            .and_then(Value::as_array)
            .is_some_and(|options| {
                !options.is_empty()
                    && options.len() <= 128
                    && options.iter().all(Value::is_string)
                    && default.is_none_or(|value| options.contains(value))
            }),
        _ => false,
    };
    if !valid
        || payload
            .get("description")
            .is_some_and(|value| value.as_str().is_none_or(|text| text.len() > 1024))
    {
        return Err(ManifestError::InvalidManifest);
    }
    Ok(())
}

fn validate_dependencies(manifest: &CapabilityManifest) -> Result<(), ManifestError> {
    if manifest.dependencies.len() > 64 {
        return Err(ManifestError::InvalidManifest);
    }
    for dependency in &manifest.dependencies {
        let valid_id = dependency
            .id
            .split_once('/')
            .is_some_and(|(publisher, package)| safe_id(publisher) && safe_id(package));
        let valid_digest = dependency.sha256.as_ref().is_none_or(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        });
        let _ = dependency.optional;
        if !valid_id || VersionReq::parse(&dependency.version).is_err() || !valid_digest {
            return Err(ManifestError::InvalidManifest);
        }
    }
    Ok(())
}

fn validate_permissions(actual: &[String], expected: &[String]) -> Result<(), ManifestError> {
    let actual_set = actual.iter().map(String::as_str).collect::<HashSet<_>>();
    let expected_set = expected.iter().map(String::as_str).collect::<HashSet<_>>();
    if actual.len() > 64
        || actual_set.len() != actual.len()
        || actual_set != expected_set
        || actual
            .iter()
            .any(|permission| !valid_permission(permission))
    {
        return Err(ManifestError::PermissionMismatch);
    }
    Ok(())
}

fn valid_permission(permission: &str) -> bool {
    matches!(
        permission,
        "hook.selection.read"
            | "hook.unit.metadata.read"
            | "hook.unit.image.read"
            | "hook.unit.attachments.read"
            | "hook.unit.attachments.write"
            | "hook.overlay.render"
            | "hook.notice.show"
            | "hook.clipboard.write"
            | "hook.external.open"
            | "loom.network.brokered"
            | "loom.pluginState.readWrite"
    ) || permission
        .strip_prefix("loom.credentials.use:")
        .is_some_and(safe_id)
}

fn validate_contribution_id(
    value: &str,
    namespace: &str,
    seen: &mut HashSet<String>,
) -> Result<(), ManifestError> {
    let folded = value.to_ascii_lowercase();
    if value.len() > 384 || !valid_qualified_id(value, namespace) || !seen.insert(folded) {
        return Err(ManifestError::InvalidManifest);
    }
    Ok(())
}

fn valid_qualified_id(value: &str, namespace: &str) -> bool {
    value.strip_prefix(namespace).is_some_and(safe_id)
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
        && !value
            .as_bytes()
            .last()
            .is_some_and(|byte| matches!(byte, b'.' | b'-' | b'_'))
}

fn valid_platform(value: &str) -> bool {
    value.split_once('-').is_some_and(|(os, arch)| {
        !os.is_empty()
            && !arch.is_empty()
            && os
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
            && arch
                .bytes()
                .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_')
    })
}

fn require_archive_entry(archive: &Path, path: &str) -> Result<(), ManifestError> {
    if !validate_archive_path(path) || !zip_entry_exists_file(archive, path)? {
        return Err(ManifestError::InvalidEntrypoint);
    }
    Ok(())
}

fn generic_lists(contributions: &Contributions) -> [(&[Contribution], usize); 10] {
    [
        (&contributions.shortcuts, 64),
        (&contributions.menus, 256),
        (&contributions.settings, 128),
        (&contributions.data_types, 64),
        (&contributions.renderers, 64),
        (&contributions.unit_overlays, 32),
        (&contributions.background_tasks, 32),
        (&contributions.resource_providers, 32),
        (&contributions.diagnostics, 64),
        (&contributions.event_subscriptions, 64),
    ]
}
