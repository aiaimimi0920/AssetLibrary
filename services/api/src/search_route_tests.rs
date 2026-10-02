use super::*;
use crate::search::{SearchFilter, SearchRepository, SearchResult};
use async_trait::async_trait;
use axum::{
    Router,
    body::{Body, to_bytes},
    http::Request,
};
use std::sync::Arc;
use tower::ServiceExt;

pub(crate) fn app(search: Arc<dyn SearchRepository>) -> Router {
    crate::router(AppState {
        catalog: Arc::new(crate::catalog::DevelopmentCatalog),
        identity: Arc::new(crate::identity::DevelopmentIdentityAdapter),
        uploads: Arc::new(crate::uploads::DevelopmentUploadRepository::default()),
        object_store: None,
        reviews: Arc::new(crate::workflow::UnavailableReviewRepository),
        moderation: Arc::new(crate::workflow::UnavailableModerationRepository),
        library: Arc::new(crate::library::UnavailableLibraryRepository),
        install_receipts: Arc::new(crate::install_receipts::UnavailableInstallReceiptRepository),
        downloads: Arc::new(crate::downloads::UnavailableDownloadRepository),
        search,
        public_releases: Arc::new(crate::public_releases::DevelopmentPublicReleaseRepository),
        publishers: Arc::new(crate::publisher::UnavailablePublisherRepository),
    })
}

#[derive(Clone, Copy)]
enum Fixture {
    Empty,
    Unavailable,
    InvalidProjection,
    InvalidCursor,
}

#[async_trait]
impl SearchRepository for Fixture {
    async fn search(&self, filter: &SearchFilter) -> Result<SearchResult, SearchError> {
        assert!((1..=100).contains(&filter.limit));
        match self {
            Self::Empty => Ok(SearchResult {
                items: vec![],
                next_cursor: None,
            }),
            Self::Unavailable => Err(SearchError::Unavailable),
            Self::InvalidProjection => Err(SearchError::InvalidProjection),
            Self::InvalidCursor => Err(SearchError::InvalidCursor),
        }
    }
}

#[tokio::test]
async fn search_route_preserves_contract_and_rejects_bad_inputs() {
    let response = app(Arc::new(Fixture::Empty))
        .oneshot(
            Request::builder()
                .uri("/v1/public/search?q=%20%E4%B8%AD%E6%96%87%20&kind=art&tag=exact&limit=1")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = to_bytes(response.into_body(), 1024).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<Value>(&body).unwrap(),
        serde_json::json!({
            "schema_version":"1.0", "items":[], "next_cursor":null
        })
    );
    for query in [
        "limit=0",
        "limit=101",
        "limit=-1",
        "kind=other",
        "tag=",
        "tag=%20bad",
        "q=%00",
        "q=%0a",
        "cursor=!!!",
    ] {
        let response = app(Arc::new(Fixture::Unavailable))
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/public/search?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{query}");
    }
    for query in [
        format!("q={}", "a".repeat(201)),
        format!("tag={}", "a".repeat(101)),
        format!("cursor={}", "a".repeat(1025)),
    ] {
        let response = app(Arc::new(Fixture::Unavailable))
            .oneshot(
                Request::builder()
                    .uri(format!("/v1/public/search?{query}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }
}

#[tokio::test]
async fn search_route_distinguishes_empty_invalid_cursor_and_dependency_failure() {
    for (fixture, status) in [
        (Fixture::Unavailable, StatusCode::SERVICE_UNAVAILABLE),
        (Fixture::InvalidProjection, StatusCode::SERVICE_UNAVAILABLE),
        (Fixture::InvalidCursor, StatusCode::BAD_REQUEST),
    ] {
        let response = app(Arc::new(fixture))
            .oneshot(
                Request::builder()
                    .uri("/v1/public/search")
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), status);
        assert!(
            to_bytes(response.into_body(), 1024)
                .await
                .unwrap()
                .is_empty()
        );
    }
}

#[test]
fn search_route_decodes_postgres_cursor_without_changing_legacy_cursor() {
    let filter = SearchFilter {
        query: None,
        kind: None,
        tag: None,
        cursor: None,
        limit: 1,
    };
    let values = crate::search_cursor::encode(
        &filter,
        time::OffsetDateTime::UNIX_EPOCH,
        Uuid::from_u128(42),
    )
    .unwrap();
    assert_eq!(
        decode_cursor(&encode_cursor(values.clone()).unwrap()).unwrap(),
        values
    );
    for invalid in [
        serde_json::json!([
            "postgres-v2",
            "1970-01-01T00:00:00Z",
            Uuid::from_u128(42),
            "a".repeat(64)
        ]),
        serde_json::json!([0, 100, Uuid::nil()]),
        serde_json::json!([0, 100]),
    ] {
        let encoded = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&invalid).unwrap());
        assert!(decode_cursor(&encoded).is_err());
    }
}
