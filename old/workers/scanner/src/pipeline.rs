use assetlibrary_object_store::{ObjectStore, ObjectStoreError};
use assetlibrary_supply_chain::{PackageKind, SignatureDocument, verify_signature_digest};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde_json::Value;
use std::{path::PathBuf, sync::Arc, time::Duration};

use crate::{
    event::VerificationRequested,
    inspection_executor::{InspectionExecutor, InspectionWorkspace},
    inspection_process,
    local_inspection::InspectionRequest,
    malware::{MalwareError, MalwareResult, scan_file},
    repository::{ArtifactContext, VerifiedRecord},
};

pub struct Pipeline {
    object_store: Arc<dyn ObjectStore>,
    clamav_address: Option<std::net::SocketAddr>,
    temporary_root: PathBuf,
    scan_timeout: Duration,
    inspection_executor: InspectionExecutor,
}

pub struct Inspection {
    _workspace: InspectionWorkspace,
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
            inspection_executor: InspectionExecutor::new(),
        }
    }

    pub async fn wait_for_idle(&self) {
        self.inspection_executor.wait_until_idle().await;
    }

    pub async fn inspect(
        &self,
        context: &ArtifactContext,
        event: &VerificationRequested,
    ) -> Result<Inspection, PipelineError> {
        let workspace = self
            .inspection_executor
            .reserve(&self.temporary_root)
            .await
            .map_err(|_| PipelineError::Retry("temporary_storage_unavailable"))?;
        let path = workspace.archive_path();
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
        let request = InspectionRequest {
            kind: match context.kind {
                PackageKind::Art => "art",
                PackageKind::Capability => "capability",
                PackageKind::AppUpdate => "app_update",
            }
            .to_owned(),
            publisher_slug: context.publisher_slug.clone(),
            package_slug: context.package_slug.clone(),
            version: context.version.clone(),
            permissions: context.permissions.clone(),
            size_bytes: context.size_bytes,
            expected_digest: event.digest.clone(),
        };
        let (workspace, inspected) = inspection_process::inspect(workspace, request)
            .await
            .map_err(|_| PipelineError::Retry("scanner_task_failed"))?;
        let inspected = inspected.map_err(|error| PipelineError::Permanent(error.code()))?;
        let signature_document = serde_json::from_value(inspected.signature.clone())
            .map_err(|_| PipelineError::Retry("scanner_task_failed"))?;
        Ok(Inspection {
            _workspace: workspace,
            path,
            raw_sha256: inspected.raw_sha256,
            canonical_sha256: inspected.canonical_sha256,
            manifest: inspected.manifest,
            signature: inspected.signature,
            signature_document,
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

fn map_download_error(error: ObjectStoreError) -> PipelineError {
    match error {
        ObjectStoreError::ObjectTooLarge => PipelineError::Permanent("artifact_too_large"),
        _ => PipelineError::Retry("quarantine_storage_unavailable"),
    }
}
