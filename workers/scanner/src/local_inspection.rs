//! Pure archive inspection shared with the credential-free child entry point.
use assetlibrary_supply_chain::{
    ExpectedPackage, PackageKind, SignatureDocument, canonical_zip_digest_file,
    read_zip_entry_file, sha256_digest, sha256_digest_file, validate_package_manifest,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionRequest {
    pub kind: String,
    pub publisher_slug: String,
    pub package_slug: String,
    pub version: String,
    pub permissions: Vec<String>,
    pub size_bytes: u64,
    pub expected_digest: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InspectionData {
    pub raw_sha256: [u8; 32],
    pub canonical_sha256: [u8; 32],
    pub manifest: Value,
    pub signature: Value,
    pub signature_key_id: String,
    pub sbom_digest: [u8; 32],
    pub provenance_digest: [u8; 32],
}

#[derive(Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum InspectionFailure {
    ArchiveInvalid,
    ArtifactDigestMismatch,
    ManifestInvalid,
    SignatureDocumentInvalid,
    AttestationMissing,
    AttestationInvalid,
    SbomInvalid,
    ProvenanceInvalid,
}

impl InspectionFailure {
    pub fn code(&self) -> &'static str {
        match self {
            Self::ArchiveInvalid => "archive_invalid",
            Self::ArtifactDigestMismatch => "artifact_digest_mismatch",
            Self::ManifestInvalid => "manifest_invalid",
            Self::SignatureDocumentInvalid => "signature_document_invalid",
            Self::AttestationMissing => "attestation_missing",
            Self::AttestationInvalid => "attestation_invalid",
            Self::SbomInvalid => "sbom_invalid",
            Self::ProvenanceInvalid => "provenance_invalid",
        }
    }
}

pub type InspectionResult = Result<InspectionData, InspectionFailure>;

pub fn inspect_local(path: &Path, request: &InspectionRequest) -> InspectionResult {
    use InspectionFailure::*;
    let (raw_sha256, size) = sha256_digest_file(path, assetlibrary_contracts::MAX_ARTIFACT_SIZE)
        .map_err(|_| ArchiveInvalid)?;
    let raw_hex = assetlibrary_supply_chain::hex_digest(&raw_sha256);
    if size != request.size_bytes
        || request.expected_digest.strip_prefix("sha256:") != Some(raw_hex.as_str())
    {
        return Err(ArtifactDigestMismatch);
    }
    let kind = match request.kind.as_str() {
        "art" => PackageKind::Art,
        "capability" => PackageKind::Capability,
        "app_update" => PackageKind::AppUpdate,
        _ => return Err(ManifestInvalid),
    };
    let expected = ExpectedPackage {
        kind,
        publisher: &request.publisher_slug,
        package: &request.package_slug,
        version: &request.version,
        permissions: &request.permissions,
    };
    let manifest = validate_package_manifest(path, &expected).map_err(|_| ManifestInvalid)?;
    let signature_bytes = read_zip_entry_file(path, &manifest.signature_file, 64 * 1024)
        .map_err(|_| SignatureDocumentInvalid)?;
    let signature: Value =
        serde_json::from_slice(&signature_bytes).map_err(|_| SignatureDocumentInvalid)?;
    let _: SignatureDocument =
        serde_json::from_slice(&signature_bytes).map_err(|_| SignatureDocumentInvalid)?;
    let canonical_sha256 = canonical_zip_digest_file(path, Some(&manifest.signature_file))
        .map_err(|_| ArchiveInvalid)?;
    let (sbom, sbom_digest) = read_json_attestation(path, "sbom.cdx.json")?;
    if sbom.get("bomFormat").and_then(Value::as_str) != Some("CycloneDX") {
        return Err(SbomInvalid);
    }
    let (provenance, provenance_digest) =
        read_json_attestation(path, "provenance/build-provenance.json")?;
    if !provenance.is_object() {
        return Err(ProvenanceInvalid);
    }
    Ok(InspectionData {
        raw_sha256,
        canonical_sha256,
        manifest: manifest.document,
        signature,
        signature_key_id: manifest.key_id,
        sbom_digest,
        provenance_digest,
    })
}

fn read_json_attestation(path: &Path, name: &str) -> Result<(Value, [u8; 32]), InspectionFailure> {
    let bytes = read_zip_entry_file(path, name, 8 * 1024 * 1024)
        .map_err(|_| InspectionFailure::AttestationMissing)?;
    let digest = sha256_digest(&bytes);
    let document =
        serde_json::from_slice(&bytes).map_err(|_| InspectionFailure::AttestationInvalid)?;
    Ok((document, digest))
}
