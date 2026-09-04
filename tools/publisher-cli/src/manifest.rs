use serde_json::{Value, json};
use std::{collections::BTreeSet, fs, io::Write, path::Path};

use crate::{
    cli::{Kind, ManifestArgs},
    error::CliError,
};

pub fn create(args: &ManifestArgs) -> Result<Value, CliError> {
    validate(args)?;
    let files = match args.identity.kind {
        Kind::Art => art(args),
        Kind::Capability => capability(args),
    };
    let output = absolute_output_directory(&args.output_dir)?;
    if fs::symlink_metadata(&output).is_ok() {
        return Err(CliError::Conflict);
    }
    let parent = output
        .parent()
        .ok_or(CliError::Configuration("manifest output has no parent"))?;
    let staging = tempfile::Builder::new()
        .prefix(".assetlibrary-manifest-")
        .tempdir_in(parent)?;
    for (name, document) in &files {
        write_new(
            &staging.path().join(name),
            &serde_json::to_vec_pretty(document)
                .map_err(|_| CliError::Validation("manifest serialization failed".to_owned()))?,
        )?;
    }
    sync_directory(staging.path())?;
    let staging_path = staging.keep();
    if let Err(error) = fs::rename(&staging_path, &output) {
        let _ = fs::remove_dir_all(staging_path);
        return Err(error.into());
    }
    sync_directory(parent)?;
    Ok(json!({
        "command":"manifest","kind":format!("{:?}", args.identity.kind).to_ascii_lowercase(),
        "output_dir":output,"files":files.iter().map(|(name, _)| *name).collect::<Vec<_>>()
    }))
}

fn art(args: &ManifestArgs) -> Vec<(&'static str, Value)> {
    vec![
        (
            "manifest.json",
            json!({
                "id":args.identity.package,"name":args.identity.package,"description":"TODO","enabled":true,
                "execution":{"type":"framework_art","framework":args.framework},
                "inputs":[],"outputs":[],"params":[],
                "metadata":{
                    "packageSecurity":{"version":args.identity.version,
                        "publisher":{"id":args.identity.publisher,"keyId":args.key_id},
                        "signature":{"algorithm":"ed25519","keyId":args.key_id,"file":"signature.json"}},
                    "art":{"qualifiedId":format!("{}/{}", args.identity.publisher, args.identity.package)},
                    "dependencies":{"framework":args.framework,"frameworkVersion":args.framework_version}
                }
            }),
        ),
        (
            "art.runtime.json",
            json!({
                "protocolVersion":"loom.art.runtime.v1",
                "entry":{"command":args.command,"args":[]}
            }),
        ),
    ]
}

fn capability(args: &ManifestArgs) -> Vec<(&'static str, Value)> {
    vec![(
        "capability.manifest.json",
        json!({
            "schemaVersion":1,"kind":"capability","id":args.identity.package,
            "name":args.identity.package,"description":"TODO","version":args.identity.version,
            "publisher":{"id":args.identity.publisher,"keyId":args.key_id},
            "hostCompatibility":{
                "loomCapabilityApi":{"minimum":"1.0","requiredFeatures":[],"optionalFeatures":[]},
                "hookExtensionApi":{"minimum":"1.0","requiredFeatures":[],"optionalFeatures":[]}
            },
            "entrypoints":{"service":{"targets":{args.platform.clone():{
                "command":args.command,"args":[]}},"processModel":"on_demand"}},
            "activationEvents":[],"contributes":{},"permissions":args.identity.permissions,
            "resources":{"memoryMiB":128,"maxProcesses":1,"timeoutSeconds":30},
            "dependencies":[],
            "signature":{"algorithm":"ed25519","keyId":args.key_id,"file":"signature.json"}
        }),
    )]
}

fn validate(args: &ManifestArgs) -> Result<(), CliError> {
    if !safe_id(&args.identity.publisher)
        || !safe_id(&args.identity.package)
        || !safe_key_id(&args.key_id)
        || semver::Version::parse(&args.identity.version).is_err()
        || semver::VersionReq::parse(&args.framework_version).is_err()
        || !safe_framework(&args.framework)
        || !safe_target(&args.platform)
        || !assetlibrary_supply_chain::validate_archive_path(&args.command)
    {
        return Err(CliError::Validation(
            "manifest identity or entrypoint is invalid".to_owned(),
        ));
    }
    if matches!(args.identity.kind, Kind::Art) && !args.identity.permissions.is_empty() {
        return Err(CliError::Validation(
            "Art packages cannot declare permissions".to_owned(),
        ));
    }
    let unique = args.identity.permissions.iter().collect::<BTreeSet<_>>();
    if unique.len() != args.identity.permissions.len()
        || args.identity.permissions.len() > 64
        || args
            .identity
            .permissions
            .iter()
            .any(|value| !valid_permission(value))
    {
        return Err(CliError::Validation(
            "capability permissions are invalid".to_owned(),
        ));
    }
    Ok(())
}

fn write_new(path: &Path, bytes: &[u8]) -> Result<(), CliError> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

fn absolute_output_directory(path: &Path) -> Result<std::path::PathBuf, CliError> {
    let name = path
        .file_name()
        .ok_or_else(|| CliError::Validation("manifest output directory is invalid".to_owned()))?;
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let parent = absolute
        .parent()
        .ok_or(CliError::Configuration("manifest output has no parent"))?;
    fs::create_dir_all(parent)?;
    let metadata = fs::symlink_metadata(parent)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(CliError::Validation(
            "manifest output parent is unsafe".to_owned(),
        ));
    }
    let parent = fs::canonicalize(parent)?;
    Ok(parent.join(name))
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), CliError> {
    fs::File::open(path)?.sync_all()?;
    Ok(())
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<(), CliError> {
    Ok(())
}

fn safe_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && value
            .bytes()
            .next()
            .is_some_and(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && !value.contains("..")
}

fn safe_key_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase()
                || byte.is_ascii_digit()
                || (index > 0 && matches!(byte, b'.' | b'_' | b'-'))
        })
}

fn safe_framework(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value.split('/').all(safe_id)
        && !value.starts_with('/')
        && !value.ends_with('/')
}

fn safe_target(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || matches!(byte, b'.' | b'_' | b'-')
        })
        && !value.contains("..")
}

fn valid_permission(value: &str) -> bool {
    matches!(
        value,
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
    ) || value
        .strip_prefix("loom.credentials.use:")
        .is_some_and(safe_id)
}
