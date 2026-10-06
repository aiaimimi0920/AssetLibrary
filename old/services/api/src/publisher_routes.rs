use assetlibrary_contracts::{
    CreatePackageRequest, CreateReleaseRequest, OwnedPackage, OwnedPackagePage, OwnedRelease,
    OwnedReleasePage, PublisherMembershipPage, PublisherReleaseWorkspace, PublisherSigningKey,
    PublisherSigningKeyPage, RegisterSigningKeyRequest, RevokeSigningKeyRequest, SCHEMA_VERSION_V1,
    UpdatePackageRequest, UpdateReleaseRequest, valid_signing_key_id,
};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header::CACHE_CONTROL},
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use uuid::Uuid;

use crate::{
    AppState,
    publisher::{MembershipCursor, PackageCursor, PageFilter, ReleaseCursor, SigningKeyCursor},
    workflow_routes::{authenticate, map_workflow, mutation_headers},
};

#[derive(Deserialize)]
pub struct PageQuery {
    cursor: Option<String>,
    limit: Option<u16>,
}

pub async fn list_memberships(
    State(state): State<AppState>,
    Query(query): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<PublisherMembershipPage>), StatusCode> {
    let principal = authenticate(&state, &headers).await?;
    let filter = membership_filter(query)?;
    let (items, next) = state
        .publishers
        .list_memberships(&principal, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(PublisherMembershipPage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn list_packages(
    State(state): State<AppState>,
    Path(publisher_id): Path<Uuid>,
    Query(query): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OwnedPackagePage>), StatusCode> {
    if publisher_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let filter = package_filter(query)?;
    let (items, next) = state
        .publishers
        .list_packages(&principal, publisher_id, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(OwnedPackagePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn create_package(
    State(state): State<AppState>,
    Path(publisher_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreatePackageRequest>,
) -> Result<(HeaderMap, Json<OwnedPackage>), StatusCode> {
    if publisher_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let package = state
        .publishers
        .create_package(&principal, publisher_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    private_json(package)
}

pub async fn list_signing_keys(
    State(state): State<AppState>,
    Path(publisher_id): Path<Uuid>,
    Query(query): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<PublisherSigningKeyPage>), StatusCode> {
    if publisher_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let filter = signing_key_filter(query)?;
    let (items, next) = state
        .publishers
        .list_signing_keys(&principal, publisher_id, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(PublisherSigningKeyPage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn register_signing_key(
    State(state): State<AppState>,
    Path(publisher_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<RegisterSigningKeyRequest>,
) -> Result<(HeaderMap, Json<PublisherSigningKey>), StatusCode> {
    if publisher_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let signing_key = state
        .publishers
        .register_signing_key(&principal, publisher_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    private_json(signing_key)
}

pub async fn revoke_signing_key(
    State(state): State<AppState>,
    Path((publisher_id, key_id)): Path<(Uuid, String)>,
    headers: HeaderMap,
    Json(request): Json<RevokeSigningKeyRequest>,
) -> Result<(HeaderMap, Json<PublisherSigningKey>), StatusCode> {
    if publisher_id.is_nil() || !valid_signing_key_id(&key_id) || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let signing_key = state
        .publishers
        .revoke_signing_key(&principal, publisher_id, &key_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    private_json(signing_key)
}

pub async fn get_package(
    State(state): State<AppState>,
    Path(package_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OwnedPackage>), StatusCode> {
    if package_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let package = state
        .publishers
        .get_package(&principal, package_id)
        .await
        .map_err(map_workflow)?;
    private_json(package)
}

pub async fn update_package(
    State(state): State<AppState>,
    Path(package_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<UpdatePackageRequest>,
) -> Result<(HeaderMap, Json<OwnedPackage>), StatusCode> {
    if package_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let package = state
        .publishers
        .update_package(&principal, package_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    private_json(package)
}

pub async fn list_releases(
    State(state): State<AppState>,
    Path(package_id): Path<Uuid>,
    Query(query): Query<PageQuery>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OwnedReleasePage>), StatusCode> {
    if package_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let filter = release_filter(query)?;
    let (items, next) = state
        .publishers
        .list_releases(&principal, package_id, &filter)
        .await
        .map_err(map_workflow)?;
    private_json(OwnedReleasePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    })
}

pub async fn create_release(
    State(state): State<AppState>,
    Path(package_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateReleaseRequest>,
) -> Result<(HeaderMap, Json<OwnedRelease>), StatusCode> {
    if package_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let release = state
        .publishers
        .create_release(&principal, package_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    private_json(release)
}

pub async fn get_release(
    State(state): State<AppState>,
    Path(release_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<OwnedRelease>), StatusCode> {
    if release_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let release = state
        .publishers
        .get_release(&principal, release_id)
        .await
        .map_err(map_workflow)?;
    private_json(release)
}

pub async fn update_release(
    State(state): State<AppState>,
    Path(release_id): Path<Uuid>,
    headers: HeaderMap,
    Json(request): Json<UpdateReleaseRequest>,
) -> Result<(HeaderMap, Json<OwnedRelease>), StatusCode> {
    if release_id.is_nil() || !request.validate() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let (key, request_id) = mutation_headers(&headers)?;
    let release = state
        .publishers
        .update_release(&principal, release_id, key, request_id, &request)
        .await
        .map_err(map_workflow)?;
    private_json(release)
}

pub async fn get_release_workspace(
    State(state): State<AppState>,
    Path(release_id): Path<Uuid>,
    headers: HeaderMap,
) -> Result<(HeaderMap, Json<PublisherReleaseWorkspace>), StatusCode> {
    if release_id.is_nil() {
        return Err(StatusCode::BAD_REQUEST);
    }
    let principal = authenticate(&state, &headers).await?;
    let workspace = state
        .publishers
        .get_release_workspace(&principal, release_id)
        .await
        .map_err(map_workflow)?;
    private_json(workspace)
}

fn membership_filter(query: PageQuery) -> Result<PageFilter<MembershipCursor>, StatusCode> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor::<MembershipCursor>)
        .transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|value| value.publisher_id.is_nil())
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(PageFilter {
        cursor,
        limit: valid_limit(query.limit)?,
    })
}

fn package_filter(query: PageQuery) -> Result<PageFilter<PackageCursor>, StatusCode> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor::<PackageCursor>)
        .transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|value| value.package_id.is_nil() || value.updated_at.unix_timestamp() <= 0)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(PageFilter {
        cursor,
        limit: valid_limit(query.limit)?,
    })
}

fn release_filter(query: PageQuery) -> Result<PageFilter<ReleaseCursor>, StatusCode> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor::<ReleaseCursor>)
        .transpose()?;
    if cursor
        .as_ref()
        .is_some_and(|value| value.release_id.is_nil() || value.created_at.unix_timestamp() <= 0)
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(PageFilter {
        cursor,
        limit: valid_limit(query.limit)?,
    })
}

fn signing_key_filter(query: PageQuery) -> Result<PageFilter<SigningKeyCursor>, StatusCode> {
    let cursor = query
        .cursor
        .as_deref()
        .map(decode_cursor::<SigningKeyCursor>)
        .transpose()?;
    if cursor.as_ref().is_some_and(|value| {
        value.created_at.unix_timestamp() <= 0 || !valid_signing_key_id(&value.key_id)
    }) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(PageFilter {
        cursor,
        limit: valid_limit(query.limit)?,
    })
}

fn valid_limit(value: Option<u16>) -> Result<u16, StatusCode> {
    let value = value.unwrap_or(20);
    (1..=100)
        .contains(&value)
        .then_some(value)
        .ok_or(StatusCode::BAD_REQUEST)
}

fn encode_cursor<T: Serialize>(value: T) -> Result<String, StatusCode> {
    serde_json::to_vec(&value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn decode_cursor<T: DeserializeOwned>(value: &str) -> Result<T, StatusCode> {
    if value.len() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .ok_or(StatusCode::BAD_REQUEST)
}

fn private_json<T>(value: T) -> Result<(HeaderMap, Json<T>), StatusCode> {
    let mut headers = HeaderMap::new();
    headers.insert(CACHE_CONTROL, HeaderValue::from_static("private, no-store"));
    Ok((headers, Json(value)))
}

#[cfg(test)]
mod tests {
    use super::{decode_cursor, encode_cursor, valid_limit};
    use crate::publisher::MembershipCursor;
    use uuid::Uuid;

    #[test]
    fn publisher_cursor_round_trips_and_page_bounds_are_strict() {
        let cursor = MembershipCursor {
            publisher_id: Uuid::new_v4(),
        };
        let encoded = encode_cursor(cursor.clone()).expect("cursor must encode");
        let decoded: MembershipCursor = decode_cursor(&encoded).expect("cursor must decode");
        assert_eq!(decoded.publisher_id, cursor.publisher_id);
        assert!(decode_cursor::<MembershipCursor>("not-a-cursor").is_err());
        assert!(valid_limit(Some(0)).is_err());
        assert_eq!(valid_limit(None).unwrap(), 20);
    }
}
