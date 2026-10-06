use assetlibrary_contracts::{CreateDownloadSessionRequest, DownloadSession, PublicDownload};
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

pub async fn public_download(
    State(state): State<AppState>,
    Path(artifact_id): Path<Uuid>,
) -> Result<Json<PublicDownload>, StatusCode> {
    if artifact_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    state
        .downloads
        .public_download(artifact_id)
        .await
        .map(Json)
        .map_err(map_workflow)
}

pub async fn issue(
    State(state): State<AppState>,
    Path(artifact_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateDownloadSessionRequest>,
) -> Result<Response, StatusCode> {
    if artifact_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let session: DownloadSession = state
        .downloads
        .issue(&principal, artifact_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    let mut response = (StatusCode::CREATED, Json(session)).into_response();
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    Ok(response)
}
