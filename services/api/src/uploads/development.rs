use assetlibrary_contracts::{ArtifactStatus, CreateUploadSessionRequest, UploadSession};
use async_trait::async_trait;
use std::{
    collections::HashMap,
    time::{SystemTime, UNIX_EPOCH},
};
use tokio::sync::Mutex;
use uuid::Uuid;

use super::{UploadRepository, UploadRepositoryError, UploadReservation};
use crate::{artifact::request_digest, identity::PrincipalRef};

#[derive(Default)]
pub struct DevelopmentUploadRepository {
    sessions: Mutex<HashMap<(String, String, String), ([u8; 32], UploadReservation)>>,
}

#[async_trait]
impl UploadRepository for DevelopmentUploadRepository {
    async fn create_session(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        key: &str,
        _request_id: &str,
        request: &CreateUploadSessionRequest,
    ) -> Result<UploadReservation, UploadRepositoryError> {
        if principal.issuer != "assetlibrary-development"
            || principal.subject != "publisher-fixture"
            || release_id
                != Uuid::parse_str("018f47d2-4a75-7fa1-a12b-9a1f19d46ea3")
                    .expect("development release fixture UUID is valid")
        {
            return Err(UploadRepositoryError::Forbidden);
        }
        let digest = request_digest(release_id, request);
        let map_key = (
            principal.issuer.clone(),
            principal.subject.clone(),
            key.to_owned(),
        );
        let mut sessions = self.sessions.lock().await;
        if let Some((stored, reservation)) = sessions.get(&map_key) {
            return if stored == &digest {
                Ok(UploadReservation {
                    session: reservation.session.clone(),
                    storage_upload_id: reservation.storage_upload_id.clone(),
                    expected_size_bytes: reservation.expected_size_bytes,
                })
            } else {
                Err(UploadRepositoryError::IdempotencyConflict)
            };
        }
        let artifact_id = Uuid::new_v4();
        let session = UploadSession {
            id: Uuid::new_v4(),
            release_id,
            artifact_id,
            object_key: format!(
                "quarantine/{release_id}/{artifact_id}/{}",
                request.file_name
            ),
            part_size_bytes: request.part_size_bytes,
            max_parts: request.part_count,
            expires_at_epoch_seconds: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|_| UploadRepositoryError::Database)?
                .as_secs()
                + 3_600,
            status: ArtifactStatus::PendingUpload,
            expected_digest: request.expected_digest.clone(),
        };
        sessions.insert(
            map_key,
            (
                digest,
                UploadReservation {
                    session: session.clone(),
                    storage_upload_id: None,
                    expected_size_bytes: request.size_bytes,
                },
            ),
        );
        Ok(UploadReservation {
            session,
            storage_upload_id: None,
            expected_size_bytes: request.size_bytes,
        })
    }

    async fn bind_storage_upload(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
        storage_upload_id: &str,
    ) -> Result<String, UploadRepositoryError> {
        let mut sessions = self.sessions.lock().await;
        let reservation = sessions
            .values_mut()
            .map(|(_, reservation)| reservation)
            .find(|reservation| {
                reservation.session.id == session_id
                    && principal.issuer == "assetlibrary-development"
                    && principal.subject == "publisher-fixture"
            })
            .ok_or(UploadRepositoryError::Forbidden)?;
        Ok(reservation
            .storage_upload_id
            .get_or_insert_with(|| storage_upload_id.to_owned())
            .clone())
    }

    async fn get_session(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
    ) -> Result<UploadReservation, UploadRepositoryError> {
        let sessions = self.sessions.lock().await;
        let reservation = sessions
            .values()
            .map(|(_, reservation)| reservation)
            .find(|reservation| {
                reservation.session.id == session_id
                    && principal.issuer == "assetlibrary-development"
                    && principal.subject == "publisher-fixture"
            })
            .ok_or(UploadRepositoryError::Forbidden)?;
        Ok(UploadReservation {
            session: reservation.session.clone(),
            storage_upload_id: reservation.storage_upload_id.clone(),
            expected_size_bytes: reservation.expected_size_bytes,
        })
    }

    async fn mark_uploaded(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
        _request_id: &str,
    ) -> Result<UploadSession, UploadRepositoryError> {
        let mut sessions = self.sessions.lock().await;
        let reservation = sessions
            .values_mut()
            .map(|(_, reservation)| reservation)
            .find(|reservation| {
                reservation.session.id == session_id
                    && principal.issuer == "assetlibrary-development"
                    && principal.subject == "publisher-fixture"
            })
            .ok_or(UploadRepositoryError::Forbidden)?;
        reservation.session.status = ArtifactStatus::Uploaded;
        Ok(reservation.session.clone())
    }
}
