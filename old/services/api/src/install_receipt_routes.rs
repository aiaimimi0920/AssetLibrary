use assetlibrary_contracts::{
    CreateInstallChallengeRequest, InstallChallenge, InstallReceipt, VerifyInstallReceiptRequest,
};
use axum::{
    Json,
    extract::{Path, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
};
use uuid::Uuid;

use crate::{
    AppState,
    workflow_routes::{authenticate, map_workflow, mutation_headers},
};

pub async fn challenge(
    State(state): State<AppState>,
    Path(download_session_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateInstallChallengeRequest>,
) -> Result<Response, StatusCode> {
    if download_session_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let challenge: InstallChallenge = state
        .install_receipts
        .challenge(&principal, download_session_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    let mut response = (StatusCode::CREATED, Json(challenge)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    Ok(response)
}

pub async fn verify(
    State(state): State<AppState>,
    Path(receipt_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<VerifyInstallReceiptRequest>,
) -> Result<Response, StatusCode> {
    if receipt_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let receipt: InstallReceipt = state
        .install_receipts
        .verify(&principal, receipt_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    let mut response = Json(receipt).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "private, no-store".parse().unwrap());
    Ok(response)
}
