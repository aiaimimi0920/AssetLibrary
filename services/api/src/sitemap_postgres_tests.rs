//! Explicit integration gate (ordinary test runs report it as ignored):
//! ASSETLIBRARY_SITEMAP_TEST_DATABASE_URL=postgresql://...@127.0.0.1/assetlibrary_sitemap_test
//! cargo test -p assetlibrary-api sitemap_postgres_gate -- --ignored --nocapture
//! Use only a disposable localhost PostgreSQL instance. DATABASE_URL is never read.
use super::*;
use crate::catalog::{CatalogRepository, PostgresCatalog};
use serde_json::Value;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::str::FromStr;

#[path = "sitemap_postgres_scenarios.rs"]
mod scenarios;
use scenarios::{current_eligibility, database_timeout, overflow};

async fn fixture() -> PgPool {
    let url = std::env::var("ASSETLIBRARY_SITEMAP_TEST_DATABASE_URL").expect(
        "explicit disposable sitemap test database is required; this gate never silently skips",
    );
    let options = PgConnectOptions::from_str(&url).expect("invalid test PostgreSQL options");
    assert!(
        matches!(options.get_host(), "localhost" | "127.0.0.1" | "::1"),
        "sitemap integration gate only accepts a localhost database"
    );
    assert_eq!(
        options.get_database(),
        Some("assetlibrary_sitemap_test"),
        "sitemap integration gate requires its dedicated disposable database name"
    );
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect_with(options)
        .await
        .expect("disposable PostgreSQL must be running");
    sqlx::raw_sql(include_str!("sitemap_postgres_fixture.sql"))
        .execute(&pool)
        .await
        .unwrap();
    pool
}

async fn execute(pool: &PgPool, sql: &str) {
    sqlx::raw_sql(sql).execute(pool).await.unwrap();
}

async fn hidden(catalog: &PostgresCatalog) {
    assert!(catalog.sitemap_shard(0x42).await.unwrap().is_empty());
    assert!(
        !catalog
            .sitemap_manifest()
            .await
            .unwrap()
            .iter()
            .any(|id| id == "42")
    );
    assert!(
        catalog
            .find_published("package-42-0")
            .await
            .unwrap()
            .is_none()
    );
}

fn uuid_index_nodes<'a>(value: &'a Value, nodes: &mut Vec<&'a Value>) {
    match value {
        Value::Object(object) => {
            if object.get("Index Name").and_then(Value::as_str) == Some("packages_pkey") {
                nodes.push(value);
            }
            for child in object.values() {
                uuid_index_nodes(child, nodes);
            }
        }
        Value::Array(array) => {
            for child in array {
                uuid_index_nodes(child, nodes);
            }
        }
        _ => {}
    }
}

async fn query_plans(pool: &PgPool) {
    let query = format!(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}",
        manifest_query()
    );
    let manifest: Value = sqlx::query_scalar(&query).fetch_one(pool).await.unwrap();
    let (lower, upper) = bounds(0x42);
    let query = format!("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) {}", shard_query());
    let shard: Value = sqlx::query_scalar(&query)
        .bind(lower)
        .bind(upper)
        .bind((SITEMAP_MAX_SLUGS + 1) as i64)
        .fetch_one(pool)
        .await
        .unwrap();
    for (label, plan, expected_loops) in [("manifest", manifest, 256), ("leaf", shard, 1)] {
        let mut nodes = Vec::new();
        uuid_index_nodes(&plan, &mut nodes);
        assert!(
            !nodes.is_empty(),
            "{label} must use the UUID primary index: {plan}"
        );
        assert!(
            nodes.iter().any(|node| {
                let condition = node["Index Cond"].as_str().unwrap_or("");
                condition.contains("id >=")
                    && condition.contains("id <=")
                    && !condition.contains("(id)::text")
                    && node["Actual Loops"].as_u64() == Some(expected_loops)
            }),
            "{label} must use bounded native UUID probes: {plan}"
        );
        println!("SITEMAP_EXPLAIN_{label}={plan}");
    }
}

#[tokio::test]
#[ignore = "requires explicit disposable localhost ASSETLIBRARY_SITEMAP_TEST_DATABASE_URL"]
async fn sitemap_postgres_gate() {
    let pool = fixture().await;
    let catalog = PostgresCatalog::new(pool.clone());
    let expected: Vec<_> = (0..=255).map(|id| format!("{id:02x}")).collect();
    assert_eq!(catalog.sitemap_manifest().await.unwrap(), expected);
    let mut seen = std::collections::BTreeSet::new();
    for id in 0..=255 {
        let slugs = catalog.sitemap_shard(id).await.unwrap();
        assert_eq!(
            slugs,
            [format!("package-{id:02x}-0"), format!("package-{id:02x}-f")]
        );
        assert!(slugs.into_iter().all(|slug| seen.insert(slug)));
    }
    assert_eq!(seen.len(), 512);
    query_plans(&pool).await;
    execute(
        &pool,
        "UPDATE packages SET updated_at=now()+interval '1 day'",
    )
    .await;
    assert_eq!(catalog.sitemap_manifest().await.unwrap(), expected);
    assert_eq!(
        catalog.sitemap_shard(0x42).await.unwrap(),
        ["package-42-0", "package-42-f"]
    );
    current_eligibility(&pool, &catalog).await;
    overflow(&pool, &catalog).await;
    execute(&pool, "UPDATE publishers SET status='suspended'").await;
    assert!(catalog.sitemap_manifest().await.unwrap().is_empty());
    assert!(catalog.sitemap_shard(0x42).await.unwrap().is_empty());
    database_timeout(&pool, &catalog).await;
    pool.close().await;
    assert!(matches!(
        catalog.sitemap_manifest().await,
        Err(CatalogError::Database(_))
    ));
    assert!(matches!(
        catalog.sitemap_shard(0x42).await,
        Err(CatalogError::Database(_))
    ));
}
