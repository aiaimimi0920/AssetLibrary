use assetlibrary_object_store::{ObjectStore, ObjectStoreError};
use assetlibrary_supply_chain::{
    ExpectedPackage, SignatureDocument, canonical_zip_digest_file, read_zip_entry_file,
    sha256_digest, sha256_digest_file, validate_package_manifest, verify_signature_digest,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};
use tempfile::TempDir;

use crate::{
    event::VerificationRequested,
    malware::{MalwareError, MalwareResult, scan_file},
    repository::{ArtifactContext, VerifiedRecord},
};

const MAX_ATTESTATION_BYTES: u64 = 8 * 1024 * 1024;

pub struct Pipeline {
    object_store: Arc<dyn ObjectStore>,
    clamav_address: Option<std::net::SocketAddr>,
    temporary_root: PathBuf,
    scan_timeout: Duration,
}

pub struct Inspection {
    _temporary_directory: TempDir,
    path: PathBuf,
    raw_sha256: [u8; 32],
    canonical_sha256: [u8; 32],
    manifest: Value,
    signature: Value,
    signature_document: SignatureDocument,
    signature_key_id: String,
    sbom_digest: [u8; 32],
    provenance_digest: [u8; 32],
}

impl Inspection {
    pub fn key_id(&self) -> &str {
        &self.signature_key_id
    }
}

struct LocalInspection {
    raw_sha256: [u8; 32],
    canonical_sha256: [u8; 32],
    manifest: Value,
    signature: Value,
    signature_document: SignatureDocument,
    signature_key_id: String,
    sbom_digest: [u8; 32],
    provenance_digest: [u8; 32],
}

#[derive(Debug, thiserror::Error)]
pub enum PipelineError {
    #[error("uploaded artifact failed validation")]
    Permanent(&'static str),
    #[error("artifact validation dependency is unavailable")]
    Retry(&'static str),
}

impl Pipeline {
    pub fn new(
        object_store: Arc<dyn ObjectStore>,
        clamav_address: Option<std::net::SocketAddr>,
        temporary_root: PathBuf,
        scan_timeout: Duration,
    ) -> Self {
        Self {
            object_store,
            clamav_address,
            temporary_root,
            scan_timeout,
        }
    }

    pub async fn inspect(
        &self,
        context: &ArtifactContext,
        event: &VerificationRequested,
    ) -> Result<Inspection, PipelineError> {
        let directory = tempfile::Builder::new()
            .prefix("assetlibrary-scan-")
            .tempdir_in(&self.temporary_root)
            .map_err(|_| PipelineError::Retry("temporary_storage_unavailable"))?;
        let path = directory.path().join("artifact.zip");
        let downloaded = self
            .object_store
            .download_quarantine_object(
                &context.object_key,
                &path,
                assetlibrary_contracts::MAX_ARTIFACT_SIZE,
            )
            .await
            .map_err(map_download_error)?;
        if downloaded != context.size_bytes {
            return Err(PipelineError::Permanent("artifact_size_mismatch"));
        }
        let expected = context.clone();
        let expected_digest = event.digest.clone();
        let inspect_path = path.clone();
        let inspected = tokio::task::spawn_blocking(move || {
            inspect_local(&inspect_path, &expected, &expected_digest)
        })
        .await
        .map_err(|_| PipelineError::Retry("scanner_task_failed"))??;
        Ok(Inspection {
            _temporary_directory: directory,
            path,
            raw_sha256: inspected.raw_sha256,
            canonical_sha256: inspected.canonical_sha256,
            manifest: inspected.manifest,
            signature: inspected.signature,
            signature_document: inspected.signature_document,
            signature_key_id: inspected.signature_key_id,
            sbom_digest: inspected.sbom_digest,
            provenance_digest: inspected.provenance_digest,
        })
    }

    pub async fn verify_and_promote(
        &self,
        inspection: Inspection,
        expected_public_key: &[u8; 32],
        media_type: &str,
    ) -> Result<VerifiedRecord, PipelineError> {
        verify_signature_digest(
            inspection.canonical_sha256,
            &inspection.signature_document,
            &inspection.signature_key_id,
            expected_public_key,
        )
        .map_err(|_| PipelineError::Permanent("signature_invalid"))?;
        let address = self
            .clamav_address
            .ok_or(PipelineError::Retry("malware_scanner_unavailable"))?;
        match scan_file(&inspection.path, address, self.scan_timeout).await {
            Ok(MalwareResult::Clean) => {}
            Ok(MalwareResult::Infected) => {
                return Err(PipelineError::Permanent("malware_detected"));
            }
            Err(MalwareError::Unavailable | MalwareError::InvalidResponse) => {
                return Err(PipelineError::Retry("malware_scanner_unavailable"));
            }
        }
        let raw_hex = assetlibrary_supply_chain::hex_digest(&inspection.raw_sha256);
        let canonical_hex = assetlibrary_supply_chain::hex_digest(&inspection.canonical_sha256);
        let published_object_key = self
            .object_store
            .put_verified_object(
                &inspection.path,
                &canonical_hex,
                &raw_hex,
                &STANDARD.encode(inspection.raw_sha256),
                media_type,
            )
            .await
            .map_err(|error| match error {
                ObjectStoreError::PublishedConflict => {
                    PipelineError::Permanent("published_object_conflict")
                }
                _ => PipelineError::Retry("published_storage_unavailable"),
            })?;
        Ok(VerifiedRecord {
            raw_sha256: inspection.raw_sha256,
            canonical_sha256: inspection.canonical_sha256,
            published_object_key,
            manifest: inspection.manifest,
            signature: inspection.signature,
            sbom_digest: inspection.sbom_digest,
            provenance_digest: inspection.provenance_digest,
        })
    }
}

fn inspect_local(
    path: &std::path::Path,
    context: &ArtifactContext,
    expected_digest: &str,
) -> Result<LocalInspection, PipelineError> {
    let (raw_sha256, size) = sha256_digest_file(path, assetlibrary_contracts::MAX_ARTIFACT_SIZE)
        .map_err(|_| PipelineError::Permanent("archive_invalid"))?;
    let raw_hex = assetlibrary_supply_chain::hex_digest(&raw_sha256);
    if size != context.size_bytes
        || expected_digest.strip_prefix("sha256:") != Some(raw_hex.as_str())
    {
        return Err(PipelineError::Permanent("artifact_digest_mismatch"));
    }
    let expected = ExpectedPackage {
        kind: context.kind,
        publisher: &context.publisher_slug,
        package: &context.package_slug,
        version: &context.version,
        permissions: &context.permissions,
    };
    let manifest = validate_package_manifest(path, &expected)
        .map_err(|_| PipelineError::Permanent("manifest_invalid"))?;
    let signature_bytes = read_zip_entry_file(path, &manifest.signature_file, 64 * 1024)
        .map_err(|_| PipelineError::Permanent("signature_document_invalid"))?;
    let signature: Value = serde_json::from_slice(&signature_bytes)
        .map_err(|_| PipelineError::Permanent("signature_document_invalid"))?;
    let signature_document = serde_json::from_slice(&signature_bytes)
        .map_err(|_| PipelineError::Permanent("signature_document_invalid"))?;
    let canonical_sha256 = canonical_zip_digest_file(path, Some(&manifest.signature_file))
        .map_err(|_| PipelineError::Permanent("archive_invalid"))?;
    let (sbom, sbom_digest) = read_json_attestation(path, "sbom.cdx.json")?;
    if sbom.get("bomFormat").and_then(Value::as_str) != Some("CycloneDX") {
        return Err(PipelineError::Permanent("sbom_invalid"));
    }
    let (provenance, provenance_digest) =
        read_json_attestation(path, "provenance/build-provenance.json")?;
    if !provenance.is_object() {
        return Err(PipelineError::Permanent("provenance_invalid"));
    }
    Ok(LocalInspection {
        raw_sha256,
        canonical_sha256,
        manifest: manifest.document,
        signature,
        signature_document,
        signature_key_id: manifest.key_id,
        sbom_digest,
        provenance_digest,
    })
}

fn read_json_attestation(
    path: &std::path::Path,
    name: &str,
) -> Result<(Value, [u8; 32]), PipelineError> {
    let bytes = read_zip_entry_file(path, name, MAX_ATTESTATION_BYTES)
        .map_err(|_| PipelineError::Permanent("attestation_missing"))?;
    let digest = sha256_digest(&bytes);
    let document = serde_json::from_slice(&bytes)
        .map_err(|_| PipelineError::Permanent("attestation_invalid"))?;
    Ok((document, digest))
}

fn map_download_error(error: ObjectStoreError) -> PipelineError {
    match error {
        ObjectStoreError::ObjectTooLarge => PipelineError::Permanent("artifact_too_large"),
        _ => PipelineError::Retry("quarantine_storage_unavailable"),
    }
}
