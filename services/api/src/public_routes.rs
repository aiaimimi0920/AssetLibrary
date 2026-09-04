use crate::{
    AppState,
    catalog::ListFilter,
    public_releases::{PublicReleaseError, ReleaseCursor, ReleaseFilter},
    routes::valid_slug,
};
use assetlibrary_contracts::{PublishedReleasePage, PublisherProfile, SCHEMA_VERSION_V1};
use axum::{
    Json,
    extract::{Path, Query, State},
    http::StatusCode,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;

#[derive(Deserialize)]
pub struct ReleaseQuery {
    pub cursor: Option<String>,
    pub limit: Option<u16>,
}

pub async fn get_publisher(
    State(state): State<AppState>,
    Path(slug): Path<String>,
) -> Result<Json<PublisherProfile>, StatusCode> {
    if !valid_slug(&slug) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let (packages, _) = state
        .catalog
        .list_published(&ListFilter {
            publisher_slug: Some(slug),
            limit: 1,
            ..ListFilter::default()
        })
        .await
        .map_err(|_| {
            tracing::error!("public publisher query failed");
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    let publisher = packages
        .into_iter()
        .next()
        .map(|package| PublisherProfile {
            schema_version: SCHEMA_VERSION_V1.to_owned(),
            publisher: package.publisher,
        })
        .filter(PublisherProfile::validate)
        .ok_or(StatusCode::NOT_FOUND)?;
    Ok(Json(publisher))
}

pub async fn list_releases(
    State(state): State<AppState>,
    Path(slug): Path<String>,
    Query(query): Query<ReleaseQuery>,
) -> Result<Json<PublishedReleasePage>, StatusCode> {
    if !valid_slug(&slug) || query.limit.is_some_and(|value| !(1..=100).contains(&value)) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let package = state
        .catalog
        .find_published(&slug)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .ok_or(StatusCode::NOT_FOUND)?;
    let (items, next) = state
        .public_releases
        .list(
            package.id,
            &package.slug,
            &ReleaseFilter {
                cursor,
                limit: query.limit.unwrap_or(20),
            },
        )
        .await
        .map_err(|error| {
            match error {
                PublicReleaseError::Database(source) => {
                    tracing::error!(error = %source, "public release query failed")
                }
                PublicReleaseError::InvalidProjection(reason) => {
                    tracing::error!(reason, "public release projection rejected")
                }
            }
            StatusCode::SERVICE_UNAVAILABLE
        })?;
    Ok(Json(PublishedReleasePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items,
        next_cursor: next.map(encode_cursor).transpose()?,
    }))
}

fn encode_cursor(value: ReleaseCursor) -> Result<String, StatusCode> {
    serde_json::to_vec(&value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn decode_cursor(value: &str) -> Result<ReleaseCursor, StatusCode> {
    if value.len() > 256 {
        return Err(StatusCode::BAD_REQUEST);
    }
    URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(|cursor: &ReleaseCursor| {
            cursor.published_at.unix_timestamp() > 0 && !cursor.release_id.is_nil()
        })
        .ok_or(StatusCode::BAD_REQUEST)
}

#[cfg(test)]
mod tests {
    use super::{decode_cursor, encode_cursor};
    use crate::public_releases::ReleaseCursor;
    use time::OffsetDateTime;
    use uuid::Uuid;

    #[test]
    fn release_cursor_round_trips_and_rejects_invalid_values() {
        let cursor = ReleaseCursor {
            published_at: OffsetDateTime::from_unix_timestamp(1_700_000_000).unwrap(),
            release_id: Uuid::new_v4(),
        };
        let encoded = encode_cursor(cursor.clone()).expect("cursor must encode");
        let decoded = decode_cursor(&encoded).expect("cursor must decode");
        assert_eq!(decoded.published_at, cursor.published_at);
        assert_eq!(decoded.release_id, cursor.release_id);
        assert!(decode_cursor("not-a-cursor").is_err());
    }
}
