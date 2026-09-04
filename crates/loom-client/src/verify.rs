use assetlibrary_contracts::{InstallChallenge, InstallHostProfile, PackageKind};
use assetlibrary_supply_chain::{
    ExpectedPackage, MAX_ARCHIVE_BYTES, PackageKind as SupplyKind, SignatureDocument,
    canonical_zip_digest_file, hex_digest, read_zip_entry_file, sha256_digest_file,
    validate_package_manifest, verify_signature_digest,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::{Version, VersionReq};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};

use crate::ClientError;

#[derive(Clone, Debug)]
pub struct VerifiedPackage {
    archive_path: PathBuf,
    challenge: InstallChallenge,
    manifest: Value,
}

impl VerifiedPackage {
    pub fn archive_path(&self) -> &Path {
        &self.archive_path
    }

    pub fn challenge(&self) -> &InstallChallenge {
        &self.challenge
    }

    pub fn manifest(&self) -> &Value {
        &self.manifest
    }
}

pub(crate) fn verify_package(
    archive_path: PathBuf,
    challenge: InstallChallenge,
    host: &InstallHostProfile,
) -> Result<VerifiedPackage, ClientError> {
    if !challenge.validate()
        || !host.validate()
        || host_digest(host)? != challenge.host_profile_sha256
        || !fresh_challenge(&challenge)
    {
        return Err(ClientError::InvalidResponse);
    }
    if challenge.artifact.size_bytes > MAX_ARCHIVE_BYTES {
        return Err(ClientError::SizeMismatch);
    }
    let (raw_digest, size) = sha256_digest_file(&archive_path, MAX_ARCHIVE_BYTES)?;
    if size != challenge.artifact.size_bytes {
        return Err(ClientError::SizeMismatch);
    }
    if hex_digest(&raw_digest) != challenge.archive_sha256 {
        return Err(ClientError::ArchiveDigestMismatch);
    }
    let trusted_key = trusted_key(&challenge)?;
    let expected = ExpectedPackage {
        kind: match &challenge.package.kind {
            PackageKind::Art => SupplyKind::Art,
            PackageKind::Capability => SupplyKind::Capability,
            PackageKind::AppUpdate => return Err(ClientError::InvalidResponse),
        },
        publisher: &challenge.package.publisher_slug,
        package: &challenge.package.package_slug,
        version: &challenge.package.version,
        permissions: &challenge.package.permissions,
    };
    let manifest = validate_package_manifest(&archive_path, &expected)?;
    if manifest.key_id != challenge.trusted_signing_key.key_id {
        return Err(ClientError::SigningKeyMismatch);
    }
    let canonical = canonical_zip_digest_file(&archive_path, Some(&manifest.signature_file))?;
    if hex_digest(&canonical) != challenge.artifact.digest {
        return Err(ClientError::CanonicalDigestMismatch);
    }
    let document: SignatureDocument = serde_json::from_slice(&read_zip_entry_file(
        &archive_path,
        &manifest.signature_file,
        64 * 1024,
    )?)
    .map_err(|_| ClientError::InvalidResponse)?;
    verify_signature_digest(canonical, &document, &manifest.key_id, &trusted_key)?;
    negotiate_host(&manifest.document, &challenge.package.kind, host)?;
    Ok(VerifiedPackage {
        archive_path,
        challenge,
        manifest: manifest.document,
    })
}

fn fresh_challenge(challenge: &InstallChallenge) -> bool {
    let now = OffsetDateTime::now_utc();
    OffsetDateTime::parse(&challenge.issued_at, &Rfc3339)
        .ok()
        .zip(OffsetDateTime::parse(&challenge.expires_at, &Rfc3339).ok())
        .is_some_and(|(issued, expires)| issued <= now + Duration::minutes(1) && expires > now)
}

fn trusted_key(challenge: &InstallChallenge) -> Result<[u8; 32], ClientError> {
    let bytes = STANDARD
        .decode(&challenge.trusted_signing_key.public_key_base64)
        .map_err(|_| ClientError::SigningKeyMismatch)?;
    if STANDARD.encode(&bytes) != challenge.trusted_signing_key.public_key_base64 {
        return Err(ClientError::SigningKeyMismatch);
    }
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| ClientError::SigningKeyMismatch)?;
    let fingerprint = format!("sha256:{}", hex::encode(Sha256::digest(key)));
    if fingerprint != challenge.trusted_signing_key.fingerprint {
        return Err(ClientError::SigningKeyMismatch);
    }
    Ok(key)
}

fn host_digest(host: &InstallHostProfile) -> Result<String, ClientError> {
    let bytes = serde_json::to_vec(host).map_err(|_| ClientError::InvalidInput("invalid host"))?;
    Ok(hex::encode(Sha256::digest(bytes)))
}

pub(crate) fn negotiate_host(
    manifest: &Value,
    kind: &PackageKind,
    host: &InstallHostProfile,
) -> Result<(), ClientError> {
    let compatible = match kind {
        PackageKind::Art => art_compatible(manifest, host),
        PackageKind::Capability => capability_compatible(manifest, host),
        PackageKind::AppUpdate => false,
    };
    compatible
        .then_some(())
        .ok_or(ClientError::HostIncompatible)
}

fn art_compatible(document: &Value, host: &InstallHostProfile) -> bool {
    let Some(framework_id) = text(document, "/execution/framework") else {
        return false;
    };
    let Some(framework) = host
        .frameworks
        .iter()
        .find(|value| value.id == framework_id && value.ready)
    else {
        return false;
    };
    let Ok(framework_version) = Version::parse(&framework.version) else {
        return false;
    };
    if let Some(requirement) = text(document, "/metadata/dependencies/frameworkVersion")
        && !VersionReq::parse(requirement)
            .ok()
            .is_some_and(|requirement| requirement.matches(&framework_version))
    {
        return false;
    }
    let Some(surface) = document.pointer("/metadata/capabilities/surface") else {
        return true;
    };
    if text(surface, "/apiVersion") != Some(host.surface_api.version.as_str()) {
        return false;
    }
    let features = host
        .surface_api
        .features
        .iter()
        .map(String::as_str)
        .collect();
    let nodes = host.surface_nodes.iter().map(String::as_str).collect();
    contains_all(surface.pointer("/requiredCapabilities"), &features)
        && contains_all(surface.pointer("/requiredNodes"), &nodes)
        && surface
            .get("variants")
            .and_then(Value::as_array)
            .is_some_and(|variants| {
                variants
                    .iter()
                    .all(|variant| contains_all(variant.get("requiredCapabilities"), &features))
            })
}

fn capability_compatible(document: &Value, host: &InstallHostProfile) -> bool {
    let compatibility = match document.get("hostCompatibility") {
        Some(Value::Object(value)) => value,
        _ => return false,
    };
    if !api_compatible(
        compatibility.get("loomCapabilityApi"),
        &host.loom_capability_api.version,
        &host.loom_capability_api.features,
    ) || !api_compatible(
        compatibility.get("hookExtensionApi"),
        &host.hook_extension_api.version,
        &host.hook_extension_api.features,
    ) || compatibility.get("surfaceApi").is_some_and(|requirement| {
        !api_compatible(
            Some(requirement),
            &host.surface_api.version,
            &host.surface_api.features,
        )
    }) {
        return false;
    }
    document
        .pointer("/entrypoints/service/targets")
        .and_then(Value::as_object)
        .is_none_or(|targets| targets.contains_key(&host.platform))
}

fn api_compatible(requirement: Option<&Value>, host_version: &str, features: &[String]) -> bool {
    let Some(Value::Object(requirement)) = requirement else {
        return false;
    };
    let Some(host_version) = api_version(host_version) else {
        return false;
    };
    let Some(minimum) = requirement
        .get("minimum")
        .and_then(Value::as_str)
        .and_then(api_version)
    else {
        return false;
    };
    let maximum = requirement
        .get("maximum")
        .and_then(Value::as_str)
        .and_then(api_version);
    let available = features.iter().map(String::as_str).collect();
    host_version >= minimum
        && maximum.is_none_or(|maximum| host_version <= maximum)
        && contains_all(requirement.get("requiredFeatures"), &available)
}

fn api_version(value: &str) -> Option<(u32, u32)> {
    let (major, minor) = value.split_once('.')?;
    Some((major.parse().ok()?, minor.parse().ok()?))
}

fn contains_all(value: Option<&Value>, available: &BTreeSet<&str>) -> bool {
    value.and_then(Value::as_array).is_none_or(|required| {
        required
            .iter()
            .all(|item| item.as_str().is_some_and(|item| available.contains(item)))
    })
}

fn text<'a>(document: &'a Value, pointer: &str) -> Option<&'a str> {
    document.pointer(pointer).and_then(Value::as_str)
}
