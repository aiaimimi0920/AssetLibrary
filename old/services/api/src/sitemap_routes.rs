use crate::{AppState, catalog::CatalogRepository};
use assetlibrary_contracts::{
    SCHEMA_VERSION_V1, SitemapManifest, SitemapShard, valid_sitemap_shard,
};
use axum::{
    Json, Router,
    extract::{FromRef, Path, RawQuery, State},
    http::{HeaderValue, StatusCode, header::CACHE_CONTROL},
    response::{IntoResponse, Response},
    routing::get,
};
use std::{future::Future, sync::Arc, time::Duration};

impl FromRef<AppState> for Arc<dyn CatalogRepository> {
    fn from_ref(state: &AppState) -> Self {
        state.catalog.clone()
    }
}

pub fn router<S>() -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    Arc<dyn CatalogRepository>: FromRef<S>,
{
    Router::new()
        .route("/v1/public/sitemap", get(manifest))
        .route("/v1/public/sitemap/{shard}", get(shard))
        .layer(axum::middleware::map_response(uncached))
}

const REQUEST_DEADLINE: Duration = Duration::from_secs(3);

async fn bounded<T>(
    future: impl Future<Output = Result<T, crate::catalog::CatalogError>>,
) -> Result<T, StatusCode> {
    tokio::time::timeout(REQUEST_DEADLINE, future)
        .await
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

async fn uncached(mut response: Response) -> Response {
    response
        .headers_mut()
        .insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response
}

pub async fn manifest(
    State(repository): State<Arc<dyn CatalogRepository>>,
    RawQuery(query): RawQuery,
) -> Response {
    let result = async {
        if query.is_some() {
            return Err(StatusCode::BAD_REQUEST);
        }
        let value = SitemapManifest {
            schema_version: SCHEMA_VERSION_V1.into(),
            shards: bounded(repository.sitemap_manifest()).await?,
        };
        if !value.validate() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        Ok(Json(value))
    }
    .await;
    result.into_response()
}

pub async fn shard(
    State(repository): State<Arc<dyn CatalogRepository>>,
    Path(shard): Path<String>,
    RawQuery(query): RawQuery,
) -> Response {
    let result = async {
        if query.is_some() || !valid_sitemap_shard(&shard) {
            return Err(StatusCode::BAD_REQUEST);
        }
        let id = u8::from_str_radix(&shard, 16).map_err(|_| StatusCode::BAD_REQUEST)?;
        let value = SitemapShard {
            schema_version: SCHEMA_VERSION_V1.into(),
            shard,
            slugs: bounded(repository.sitemap_shard(id)).await?,
        };
        if !value.validate() {
            return Err(StatusCode::SERVICE_UNAVAILABLE);
        }
        Ok(Json(value))
    }
    .await;
    result.into_response()
}

#[cfg(test)]
#[path = "sitemap_route_tests.rs"]
mod tests;
