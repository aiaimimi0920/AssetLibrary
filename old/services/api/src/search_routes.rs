use assetlibrary_contracts::{PackageKind, PackagePage, SCHEMA_VERSION_V1};
use axum::{
    Json,
    extract::{Query, State},
    http::StatusCode,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

use crate::{
    AppState,
    search::{SearchError, SearchFilter},
};

#[derive(Deserialize)]
pub struct SearchQuery {
    q: Option<String>,
    kind: Option<String>,
    tag: Option<String>,
    cursor: Option<String>,
    limit: Option<u16>,
}

pub async fn search(
    State(state): State<AppState>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<PackagePage>, StatusCode> {
    let invalid_text = query.q.as_ref().is_some_and(|value| has_control(value));
    let text = query
        .q
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty());
    if invalid_text
        || text.as_ref().is_some_and(|value| value.len() > 200)
        || query.tag.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > 100 || value.trim() != value || has_control(value)
        })
        || query.limit.is_some_and(|value| !(1..=100).contains(&value))
    {
        return Err(StatusCode::BAD_REQUEST);
    }
    let kind = query.kind.as_deref().map(parse_kind).transpose()?;
    let cursor = query.cursor.as_deref().map(decode_cursor).transpose()?;
    let result = state
        .search
        .search(&SearchFilter {
            query: text,
            kind,
            tag: query.tag,
            cursor,
            limit: query.limit.unwrap_or(24),
        })
        .await
        .map_err(|error| match error {
            SearchError::InvalidCursor => StatusCode::BAD_REQUEST,
            SearchError::Unavailable | SearchError::InvalidProjection => {
                StatusCode::SERVICE_UNAVAILABLE
            }
        })?;
    Ok(Json(PackagePage {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        items: result.items,
        next_cursor: result.next_cursor.map(encode_cursor).transpose()?,
    }))
}

fn has_control(value: &str) -> bool {
    value.chars().any(char::is_control)
}

fn parse_kind(value: &str) -> Result<PackageKind, StatusCode> {
    match value {
        "art" => Ok(PackageKind::Art),
        "capability" => Ok(PackageKind::Capability),
        "app_update" => Ok(PackageKind::AppUpdate),
        _ => Err(StatusCode::BAD_REQUEST),
    }
}

fn encode_cursor(value: Vec<Value>) -> Result<String, StatusCode> {
    serde_json::to_vec(&value)
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)
}

fn decode_cursor(value: &str) -> Result<Vec<Value>, StatusCode> {
    if value.len() > 1024 {
        return Err(StatusCode::BAD_REQUEST);
    }
    let decoded = URL_SAFE_NO_PAD
        .decode(value)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Vec<Value>>(&bytes).ok())
        .filter(|parts| {
            (crate::search_cursor::valid_postgres_shape(parts))
                || (parts.len() == 3
                    && parts[0]
                        .as_f64()
                        .is_some_and(|value| value.is_finite() && value >= 0.0)
                    && (parts[1]
                        .as_i64()
                        .is_some_and(|value| (0..=253_402_300_799_000).contains(&value))
                        || parts[1]
                            .as_str()
                            .is_some_and(|value| !value.is_empty() && value.len() <= 64))
                    && parts[2]
                        .as_str()
                        .and_then(|value| Uuid::parse_str(value).ok())
                        .is_some_and(|value| !value.is_nil()))
        });
    decoded.ok_or(StatusCode::BAD_REQUEST)
}

#[cfg(test)]
mod tests {
    use super::{decode_cursor, encode_cursor};
    use serde_json::json;

    #[test]
    fn accepts_opensearch_numeric_date_sort_cursor() {
        let parts = vec![
            json!(1.25),
            json!(1_788_000_000_000_i64),
            json!("22222222-2222-4222-8222-222222222222"),
        ];
        let encoded = encode_cursor(parts.clone()).unwrap();
        assert_eq!(decode_cursor(&encoded).unwrap(), parts);
    }
}

#[cfg(test)]
#[path = "search_route_tests.rs"]
pub(crate) mod route_tests;
