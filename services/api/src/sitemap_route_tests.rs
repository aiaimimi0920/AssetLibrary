use super::*;
use crate::catalog::{CatalogCursor, CatalogError, ListFilter};
use assetlibrary_contracts::{PublishedPackage, SITEMAP_MAX_SLUGS};
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use serde_json::{Value, json};
use tower::ServiceExt;

#[derive(Clone, Copy)]
enum Fixture {
    Valid,
    Empty,
    Invalid,
    Duplicate,
    Overflow,
    Unavailable,
    Timeout,
}

#[async_trait]
impl CatalogRepository for Fixture {
    async fn ready(&self) -> Result<(), CatalogError> {
        Ok(())
    }
    async fn list_published(
        &self,
        _: &ListFilter,
    ) -> Result<(Vec<PublishedPackage>, Option<CatalogCursor>), CatalogError> {
        unreachable!("sitemap must use the dedicated bounded projection")
    }
    async fn find_published(&self, _: &str) -> Result<Option<PublishedPackage>, CatalogError> {
        unreachable!("sitemap must not walk package details")
    }
    async fn sitemap_manifest(&self) -> Result<Vec<String>, CatalogError> {
        match self {
            Self::Unavailable => Err(CatalogError::Unavailable),
            Self::Timeout => std::future::pending().await,
            Self::Empty => Ok(vec![]),
            Self::Invalid => Ok(vec!["FF".into()]),
            Self::Duplicate => Ok(vec!["00".into(), "00".into()]),
            Self::Overflow => Ok((0..=256).map(|id| format!("{id:02x}")).collect()),
            Self::Valid => Ok(vec!["00".into(), "ff".into()]),
        }
    }
    async fn sitemap_shard(&self, shard: u8) -> Result<Vec<String>, CatalogError> {
        match self {
            Self::Unavailable => Err(CatalogError::Unavailable),
            Self::Timeout => std::future::pending().await,
            Self::Empty => Ok(vec![]),
            Self::Invalid => Ok(vec!["private/path".into()]),
            Self::Duplicate => Ok(vec!["same".into(), "same".into()]),
            Self::Overflow => Ok((0..=SITEMAP_MAX_SLUGS).map(|i| format!("p-{i}")).collect()),
            Self::Valid => Ok(vec![format!("package-{shard:02x}")]),
        }
    }
}

fn app(fixture: Fixture) -> Router {
    let repository: Arc<dyn CatalogRepository> = Arc::new(fixture);
    super::router().with_state(repository)
}

async fn request(fixture: Fixture, path: &str) -> (StatusCode, Vec<u8>) {
    let response = app(fixture)
        .oneshot(Request::builder().uri(path).body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    let status = response.status();
    let body = to_bytes(response.into_body(), 650_000).await.unwrap();
    (status, body.to_vec())
}

#[tokio::test]
async fn sitemap_routes_return_only_compact_versioned_contracts() {
    let (status, body) = request(Fixture::Valid, "/v1/public/sitemap").await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        json!({"schema_version":"1.0", "shards":["00", "ff"]})
    );
    for id in 0..=255 {
        let path = format!("/v1/public/sitemap/{id:02x}");
        let (status, body) = request(Fixture::Valid, &path).await;
        assert_eq!(status, StatusCode::OK);
        assert_eq!(
            serde_json::from_slice::<Value>(&body).unwrap(),
            json!({
                "schema_version":"1.0", "shard":format!("{id:02x}"),
                "slugs":[format!("package-{id:02x}")]
            })
        );
    }
}

#[tokio::test]
async fn sitemap_routes_reject_noncanonical_shards_and_any_query() {
    for path in [
        "/v1/public/sitemap?cursor=secret",
        "/v1/public/sitemap?limit=1",
        "/v1/public/sitemap?",
        "/v1/public/sitemap/00?limit=1",
        "/v1/public/sitemap/00?",
        "/v1/public/sitemap/FF",
        "/v1/public/sitemap/0",
        "/v1/public/sitemap/000",
        "/v1/public/sitemap/gg",
        "/v1/public/sitemap/-1",
        "/v1/public/sitemap/%FF",
    ] {
        let (status, _) = request(Fixture::Unavailable, path).await;
        assert_eq!(status, StatusCode::BAD_REQUEST, "{path}");
    }
}

#[tokio::test]
async fn sitemap_routes_distinguish_true_empty_from_invalid_or_unavailable() {
    for path in ["/v1/public/sitemap", "/v1/public/sitemap/00"] {
        let (status, body) = request(Fixture::Empty, path).await;
        assert_eq!(status, StatusCode::OK);
        let body: Value = serde_json::from_slice(&body).unwrap();
        assert!(
            body.get("shards")
                .or_else(|| body.get("slugs"))
                .unwrap()
                .as_array()
                .unwrap()
                .is_empty()
        );
        for fixture in [
            Fixture::Invalid,
            Fixture::Duplicate,
            Fixture::Overflow,
            Fixture::Unavailable,
        ] {
            let (status, body) = request(fixture, path).await;
            assert_eq!(status, StatusCode::SERVICE_UNAVAILABLE);
            assert!(body.is_empty());
        }
    }
}

#[tokio::test]
async fn sitemap_request_deadline_fails_closed() {
    let (manifest, shard) = tokio::join!(
        request(Fixture::Timeout, "/v1/public/sitemap"),
        request(Fixture::Timeout, "/v1/public/sitemap/00"),
    );
    assert_eq!(manifest.0, StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(shard.0, StatusCode::SERVICE_UNAVAILABLE);
}
