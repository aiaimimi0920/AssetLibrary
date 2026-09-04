use crate::{
    AppState,
    artifact::validate_create_request,
    catalog::{CatalogCursor, ListFilter},
    identity::IdentityError,
    uploads::UploadRepositoryError,
};
use assetlibrary_contracts::{
    ArtifactStatus, CompleteUploadSessionRequest, CreateUploadSessionRequest, PackageKind,
    PackagePage, PresignUploadPartRequest, PresignedUploadPart, ResumableUploadSession,
    SCHEMA_VERSION_V1, UploadSession, UploadedPart,
};
use assetlibrary_object_store::CompletedPart as StorageCompletedPart;
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use base64::{
    Engine as _,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Deserialize)]
pub struct ListQuery {
    pub kind: Option<String>,
    pub publisher: Option<String>,
    pub cursor: Option<String>,
    pub limit: Option<u16>,
}

pub async fn list_packages(
    State(state): State<AppState>,
    Query(query): Query<ListQuery>,
) -> Result<Json<PackagePage>, StatusCode> {
    let kind = query.kind.as_deref().and_then(|value| match value {
        "art" => Some(PackageKind::Art),
        "capability" => Some(PackageKind::Capability),
        "app_update" => Some(PackageKind::AppUpdate),
        _ => None,
    });
    if query.kind.is_some() && kind.is_none() {
        return Err(StatusCode::BAD_REQUEST);
    }
    if query.limit.is_some_and(|value| !(1..=100).contains(&value)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    if query
        .publisher
        .as_ref()
        .is_some_and(|value| !valid_slug(value))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_catalog_cursor)
        .transpose()?;
    let (packages, next) = state
        .catalog
        .list_published(&ListFilter {
            kind,
            publisher_slug: query.publisher,
            cursor,
            limit: query.limit.unwrap_or(24),
        })
        .await
        .map_err(|_| {
            tracing::error!("catalog list query failed");
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    Ok(Json(PackagePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items: packages,
        next_cursor: next.map(encode_catalog_cursor).transpose()?,
    }))
}

fn encode_catalog_cursor(value: CatalogCursor) -> Result<String, StatusCode> {
    serde_json::to_vec(&value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn decode_catalog_cursor(value: &str) -> Result<CatalogCursor, StatusCode> {
    if value.len() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|cursor: &CatalogCursor| {
            cursor.updated_at.unix_timestamp() > 0 && !cursor.package_id.is_nil()
        })
        .ok_or(StatusCode::BAD_REQUEST)
}

pub async fn get_package(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<impl IntoResponse, StatusCode> {
    if !valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .catalog
        .find_published(&slug)
        .await
        .map_err(|_| {
            tracing::error!("catalog detail query failed");
            StatusCode::SERVICE_UNAVAILABLE
        })?
        .map(|package| (StatusCode::OK, Json(package)).into_response())
        .ok_or(StatusCode::NOT_FOUND)
}

pub(crate) fn valid_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

pub async fn get_me(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<crate::identity::PrincipalRef>, StatusCode> {
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    state
        .identity
        .authenticate(authorization)
        .await
        .map(Json)
        .map_err(|error| match error {
            crate::identity::IdentityError::MissingCredential
            | crate::identity::IdentityError::InvalidCredential => StatusCode::UNAUTHORIZED,
            crate::identity::IdentityError::ExternalUnavailable => StatusCode::SERVICE_UNAVAILABLE,
        })
}

pub async fn create_upload_session(
    State(state): State<AppState>,
    Path(release_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateUploadSessionRequest>,
) -> Result<Json<UploadSession>, StatusCode> {
    validate_create_request(&request).map_err(|_| StatusCode::BAD_REQUEST)?;
    let object_store = state
        .object_store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let principal =
        state
            .identity
            .authenticate(authorization)
            .await
            .map_err(|error| match error {
                IdentityError::MissingCredential | IdentityError::InvalidCredential => {
                    StatusCode::UNAUTHORIZED
                }
                IdentityError::ExternalUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            })?;
    let idempotency_key = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
        .filter(|value| value.len() <= 200 && value.len() >= 8)
        .ok_or(StatusCode::BAD_REQUEST)?;
    let request_id = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or(StatusCode::BAD_REQUEST)?;
    let reservation = state
        .uploads
        .create_session(
            &principal,
            release_id,
            idempotency_key,
            request_id,
            &request,
        )
        .await
        .map_err(|error| match error {
            UploadRepositoryError::Forbidden => StatusCode::FORBIDDEN,
            UploadRepositoryError::IdempotencyConflict => StatusCode::CONFLICT,
            UploadRepositoryError::Database => StatusCode::SERVICE_UNAVAILABLE,
        })?;
    if reservation.storage_upload_id.is_none() {
        let new_upload_id = object_store
            .create_quarantine_upload(&reservation.session.object_key, &request.media_type)
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
        match state
            .uploads
            .bind_storage_upload(&principal, reservation.session.id, &new_upload_id)
            .await
        {
            Ok(bound_upload_id) if bound_upload_id != new_upload_id => {
                let _ = object_store
                    .abort_quarantine_upload(&reservation.session.object_key, &new_upload_id)
                    .await;
            }
            Ok(_) => {}
            Err(error) => {
                let _ = object_store
                    .abort_quarantine_upload(&reservation.session.object_key, &new_upload_id)
                    .await;
                return Err(match error {
                    UploadRepositoryError::Forbidden => StatusCode::FORBIDDEN,
                    UploadRepositoryError::IdempotencyConflict => StatusCode::CONFLICT,
                    UploadRepositoryError::Database => StatusCode::SERVICE_UNAVAILABLE,
                });
            }
        }
    }
    Ok(Json(reservation.session))
}

pub async fn presign_upload_part(
    State(state): State<AppState>,
    Path((session_id, part_number)): Path<(Uuid, u16)>,
    headers: HeaderMap,
    Json(request): Json<PresignUploadPartRequest>,
) -> Result<Json<PresignedUploadPart>, StatusCode> {
    let object_store = state
        .object_store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let principal =
        state
            .identity
            .authenticate(authorization)
            .await
            .map_err(|error| match error {
                IdentityError::MissingCredential | IdentityError::InvalidCredential => {
                    StatusCode::UNAUTHORIZED
                }
                IdentityError::ExternalUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            })?;
    let checksum = STANDARD
        .decode(request.checksum_sha256_base64.as_bytes())
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    if checksum.len() != 32 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let reservation = state
        .uploads
        .get_session(&principal, session_id)
        .await
        .map_err(|error| match error {
            UploadRepositoryError::Forbidden => StatusCode::FORBIDDEN,
            UploadRepositoryError::IdempotencyConflict => StatusCode::CONFLICT,
            UploadRepositoryError::Database => StatusCode::SERVICE_UNAVAILABLE,
        })?;
    if reservation.session.status != ArtifactStatus::PendingUpload {
        return Err(StatusCode::CONFLICT);
    }
    reservation
        .session
        .validate_part(
            part_number,
            request.size_bytes,
            part_number == reservation.session.max_parts,
        )
        .map_err(|_| StatusCode::BAD_REQUEST)?;
    let storage_upload_id = reservation
        .storage_upload_id
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let presigned = object_store
        .presign_upload_part(
            &reservation.session.object_key,
            &storage_upload_id,
            part_number,
            request.size_bytes,
            &request.checksum_sha256_base64,
        )
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    Ok(Json(PresignedUploadPart {
        part_number,
        method: presigned.method,
        url: presigned.url,
        headers: presigned.headers,
        expires_in_seconds: presigned.expires_in_seconds,
    }))
}

pub async fn get_upload_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    let object_store = state
        .object_store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let principal =
        state
            .identity
            .authenticate(authorization)
            .await
            .map_err(|error| match error {
                IdentityError::MissingCredential | IdentityError::InvalidCredential => {
                    StatusCode::UNAUTHORIZED
                }
                IdentityError::ExternalUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            })?;
    let reservation = state
        .uploads
        .get_session(&principal, session_id)
        .await
        .map_err(|error| match error {
            UploadRepositoryError::Forbidden => StatusCode::FORBIDDEN,
            UploadRepositoryError::IdempotencyConflict => StatusCode::CONFLICT,
            UploadRepositoryError::Database => StatusCode::SERVICE_UNAVAILABLE,
        })?;
    let uploaded_parts = if reservation.session.status == ArtifactStatus::Uploaded {
        Vec::new()
    } else {
        let storage_upload_id = reservation
            .storage_upload_id
            .as_deref()
            .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
        object_store
            .list_quarantine_upload_parts(&reservation.session.object_key, storage_upload_id)
            .await
            .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
            .into_iter()
            .filter_map(|part| {
                let is_last = part.part_number == reservation.session.max_parts;
                let valid_size = reservation
                    .session
                    .validate_part(part.part_number, part.size_bytes, is_last)
                    .is_ok();
                let valid_checksum = STANDARD
                    .decode(part.checksum_sha256_base64.as_bytes())
                    .is_ok_and(|value| value.len() == 32);
                let valid_etag = !part.etag.is_empty()
                    && part.etag.len() <= 200
                    && part.etag.bytes().all(|byte| byte.is_ascii_graphic());
                (valid_size && valid_checksum && valid_etag).then_some(UploadedPart {
                    part_number: part.part_number,
                    etag: part.etag,
                    checksum_sha256_base64: part.checksum_sha256_base64,
                    size_bytes: part.size_bytes,
                })
            })
            .collect()
    };
    let response = ResumableUploadSession {
        id: reservation.session.id,
        release_id: reservation.session.release_id,
        artifact_id: reservation.session.artifact_id,
        part_size_bytes: reservation.session.part_size_bytes,
        max_parts: reservation.session.max_parts,
        size_bytes: reservation.expected_size_bytes,
        expires_at_epoch_seconds: reservation.session.expires_at_epoch_seconds,
        status: reservation.session.status,
        expected_digest: reservation.session.expected_digest,
        uploaded_parts,
    };
    Ok(([("cache-control", "private, no-store")], Json(response)))
}

pub async fn complete_upload_session(
    State(state): State<AppState>,
    Path(session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CompleteUploadSessionRequest>,
) -> Result<Json<UploadSession>, StatusCode> {
    let object_store = state
        .object_store
        .as_ref()
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    let authorization = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok());
    let principal =
        state
            .identity
            .authenticate(authorization)
            .await
            .map_err(|error| match error {
                IdentityError::MissingCredential | IdentityError::InvalidCredential => {
                    StatusCode::UNAUTHORIZED
                }
                IdentityError::ExternalUnavailable => StatusCode::SERVICE_UNAVAILABLE,
            })?;
    let request_id = headers
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value.bytes().all(|byte| byte.is_ascii_graphic())
        })
        .ok_or(StatusCode::BAD_REQUEST)?;
    let reservation = state
        .uploads
        .get_session(&principal, session_id)
        .await
        .map_err(|error| match error {
            UploadRepositoryError::Forbidden => StatusCode::FORBIDDEN,
            UploadRepositoryError::IdempotencyConflict => StatusCode::CONFLICT,
            UploadRepositoryError::Database => StatusCode::SERVICE_UNAVAILABLE,
        })?;
    if reservation.session.status == ArtifactStatus::Uploaded {
        return Ok(Json(reservation.session));
    }
    if request.parts.len() != usize::from(reservation.session.max_parts) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let mut storage_parts = Vec::with_capacity(request.parts.len());
    for (index, part) in request.parts.iter().enumerate() {
        let expected_number = u16::try_from(index + 1).map_err(|_| StatusCode::BAD_REQUEST)?;
        let checksum = STANDARD
            .decode(part.checksum_sha256_base64.as_bytes())
            .map_err(|_| StatusCode::BAD_REQUEST)?;
        if part.part_number != expected_number
            || checksum.len() != 32
            || part.etag.is_empty()
            || part.etag.len() > 200
            || !part.etag.bytes().all(|byte| byte.is_ascii_graphic())
        {
            return Err(StatusCode::BAD_REQUEST);
        }
        storage_parts.push(StorageCompletedPart {
            part_number: part.part_number,
            etag: part.etag.clone(),
            checksum_sha256_base64: part.checksum_sha256_base64.clone(),
        });
    }
    let storage_upload_id = reservation
        .storage_upload_id
        .ok_or(StatusCode::SERVICE_UNAVAILABLE)?;
    object_store
        .complete_quarantine_upload(
            &reservation.session.object_key,
            &storage_upload_id,
            &storage_parts,
            reservation.expected_size_bytes,
            reservation
                .session
                .expected_digest
                .value
                .strip_prefix("sha256:")
                .ok_or(StatusCode::SERVICE_UNAVAILABLE)?,
        )
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;
    state
        .uploads
        .mark_uploaded(&principal, session_id, request_id)
        .await
        .map(Json)
        .map_err(|error| match error {
            UploadRepositoryError::Forbidden => StatusCode::FORBIDDEN,
            UploadRepositoryError::IdempotencyConflict => StatusCode::CONFLICT,
            UploadRepositoryError::Database => StatusCode::SERVICE_UNAVAILABLE,
        })
}
