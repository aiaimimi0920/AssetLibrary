use assetlibrary_contracts::{
    LibraryEntry, LibraryPage, SCHEMA_VERSION_V1, UpdateLibraryEntryRequest,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use uuid::Uuid;

use crate::{
    AppState,
    library::LibraryCursor,
    workflow_routes::{authenticate, map_workflow, mutation_headers},
};

#[derive(Deserialize)]
pub struct LibraryQuery {
    cursor: Option<String>,
    limit: Option<u16>,
}

pub async fn list(
    State(state): State<AppState>,
    Query(query): Query<LibraryQuery>,
    headers: HeaderMap,
) -> Result<Json<LibraryPage>, StatusCode> {
    let principal = authenticate(&state, &headers).await?;
    if query.limit.is_some_and(|value| !(1..=100).contains(&value)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let (items, next) = state
        .library
        .list(&principal, cursor, query.limit.unwrap_or(50))
        .await
        .map_err(map_workflow)?;
    Ok(Json(LibraryPage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    }))
}

pub async fn update(
    State(state): State<AppState>,
    Path(package_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<UpdateLibraryEntryRequest>,
) -> Result<Json<LibraryEntry>, StatusCode> {
    if package_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    state
        .library
        .update(&principal, package_id, key, request_id, &request)
        .await
        .map(Json)
        .map_err(map_workflow)
}

fn encode_cursor(value: LibraryCursor) -> Result<String, StatusCode> {
    serde_json::to_vec(&value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn decode_cursor(value: &str) -> Result<LibraryCursor, StatusCode> {
    if value.len() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|cursor: &LibraryCursor| !cursor.package_id.is_nil())
        .ok_or(StatusCode::BAD_REQUEST)
}
