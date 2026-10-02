//! Explicit real-SQL gate. Uses temporary tables in the existing disposable CI
//! database, never DATABASE_URL or a remote service. Ordinary runs show ignored.
use super::*;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;
use tower::ServiceExt;
use uuid::Uuid;

#[path = "search_postgres_cancellation.rs"]
mod cancellation;
#[path = "search_postgres_scenarios.rs"]
mod scenarios;

fn filter() -> SearchFilter {
    SearchFilter {
        query: None,
        kind: None,
        tag: None,
        cursor: None,
        limit: 100,
    }
}

async fn execute(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.unwrap();
}

async fn fixture() -> PgPool {
    let url = std::env::var("ASSETLIBRARY_SEARCH_TEST_DATABASE_URL")
        .expect("explicit disposable PostgreSQL URL required; this gate never silently skips");
    let options = PgConnectOptions::from_str(&url).expect("invalid test database options");
    assert!(matches!(
        options.get_host(),
        "localhost" | "127.0.0.1" | "::1"
    ));
    assert_eq!(
        options.get_database(),
        Some("assetlibrary_sitemap_test"),
        "search gate reuses only the dedicated disposable CI database with temporary tables"
    );
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect_with(options)
        .await
        .expect("disposable PostgreSQL must be running");
    execute(&pool, include_str!("search_postgres_fixture.sql")).await;
    pool
}

async fn text_and_filters(search: &PostgresSearchRepository) {
    for text in [
        "中文",
        "摘要",
        "详细",
        "100%_C:\\path",
        "%",
        "_",
        "c:\\PATH",
    ] {
        let mut query = filter();
        query.query = Some(text.into());
        let result = search.search(&query).await.unwrap();
        assert_eq!(result.items.len(), 1, "literal Unicode match: {text}");
        assert_eq!(result.items[0].slug, "package-1");
    }
    for text in ["not found", "' OR 1=1 --", "中文_", "100%X"] {
        let mut query = filter();
        query.query = Some(text.into());
        assert!(
            search.search(&query).await.unwrap().items.is_empty(),
            "{text}"
        );
    }
    let mut query = filter();
    query.query = Some("发布者".into());
    assert_eq!(search.search(&query).await.unwrap().items.len(), 8);
    query.tag = Some("exact".into());
    assert_eq!(
        search.search(&query).await.unwrap().items[0].slug,
        "package-1"
    );
    assert_eq!(search.search(&query).await.unwrap().items.len(), 1);
    query.tag = Some("Exact".into());
    assert!(search.search(&query).await.unwrap().items.is_empty());
    query = filter();
    query.kind = Some(PackageKind::Capability);
    assert_eq!(
        search.search(&query).await.unwrap().items[0].slug,
        "package-8"
    );
    assert_eq!(search.search(&query).await.unwrap().items.len(), 1);
    query.tag = Some("中文".into());
    assert!(search.search(&query).await.unwrap().items.is_empty());
}

async fn pagination(search: &PostgresSearchRepository) {
    for limit in [1, 2, 3, 8, 100] {
        let mut query = filter();
        query.limit = limit;
        let mut seen = Vec::new();
        loop {
            let result = search.search(&query).await.unwrap();
            assert!(!result.items.is_empty());
            assert!(result.items.len() <= usize::from(limit));
            seen.extend(result.items.into_iter().map(|item| item.id));
            query.cursor = result.next_cursor;
            if query.cursor.is_none() {
                break;
            }
            assert!(seen.len() < 8, "pagination must terminate");
        }
        assert_eq!(seen, (1..=8).map(Uuid::from_u128).collect::<Vec<_>>());
    }
    let mut query = filter();
    query.limit = 1;
    query.cursor = search.search(&query).await.unwrap().next_cursor;
    query.query = Some("changed".into());
    assert!(matches!(
        search.search(&query).await,
        Err(SearchError::InvalidCursor)
    ));
}

#[tokio::test]
async fn postgres_search_bounds_pool_wait_and_rejects_other_provider_before_database() {
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .connect_lazy("postgresql://assetlibrary@127.0.0.1:9/assetlibrary")
        .unwrap();
    let search = PostgresSearchRepository::new(pool);
    let mut query = filter();
    query.cursor = Some(vec![
        serde_json::json!(1.0),
        serde_json::json!(100),
        serde_json::json!(Uuid::from_u128(1)),
    ]);
    assert!(matches!(
        search.search(&query).await,
        Err(SearchError::InvalidCursor)
    ));
    let started = Instant::now();
    assert!(matches!(
        search.search(&filter()).await,
        Err(SearchError::Unavailable)
    ));
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[tokio::test]
#[ignore = "requires explicit disposable localhost ASSETLIBRARY_SEARCH_TEST_DATABASE_URL"]
async fn search_postgres_gate() {
    let pool = fixture().await;
    let search = PostgresSearchRepository::new(pool.clone());
    text_and_filters(&search).await;
    pagination(&search).await;
    let response = crate::search_routes::route_tests::app(std::sync::Arc::new(
        PostgresSearchRepository::new(pool.clone()),
    ))
    .oneshot(
        axum::http::Request::builder()
            .uri("/v1/public/search?limit=1")
            .body(axum::body::Body::empty())
            .unwrap(),
    )
    .await
    .unwrap();
    assert_eq!(response.status(), axum::http::StatusCode::OK);
    let bytes = axum::body::to_bytes(response.into_body(), 4096)
        .await
        .unwrap();
    let page: assetlibrary_contracts::PackagePage = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(page.items[0].slug, "package-1");
    assert!(page.next_cursor.is_some());
    scenarios::eligibility_and_revocation(&pool, &search).await;
    scenarios::deadline_and_recovery(&pool, &search).await;
    cancellation::during_begin().await;
    pool.close().await;
    assert!(matches!(
        search.search(&filter()).await,
        Err(SearchError::Unavailable)
    ));
}
