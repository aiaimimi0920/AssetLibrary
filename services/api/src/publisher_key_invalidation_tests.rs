use super::*;
use assetlibrary_contracts::CatalogInvalidated;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{str::FromStr, time::Duration};

#[tokio::test]
#[ignore = "requires explicitly selected disposable loopback PostgreSQL"]
async fn signing_key_catalog_gate() {
    let url =
        std::env::var("ASSETLIBRARY_KEY_TEST_DATABASE_URL").expect("explicit test URL required");
    let options = PgConnectOptions::from_str(&url).unwrap();
    assert!(matches!(
        options.get_host(),
        "127.0.0.1" | "localhost" | "::1"
    ));
    assert_eq!(options.get_database(), Some("assetlibrary_sitemap_test"));
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(Duration::from_secs(3))
        .connect_with(options)
        .await
        .unwrap();
    sqlx::raw_sql(
        r#"
        CREATE TEMP TABLE packages(id uuid PRIMARY KEY, publisher_id uuid);
        CREATE TEMP TABLE releases(id uuid PRIMARY KEY, package_id uuid);
        CREATE TEMP TABLE artifacts(id uuid PRIMARY KEY, release_id uuid, signature jsonb);
        CREATE TEMP TABLE outbox_events(id uuid PRIMARY KEY, subject text, schema_version text,
            aggregate_type text, aggregate_id uuid, payload jsonb);
    "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let publisher = Uuid::new_v4();
    let affected = Uuid::new_v4();
    for (package, owner, key, count) in [
        (affected, publisher, "key-1", 2),
        (Uuid::new_v4(), publisher, "other-key", 1),
        (Uuid::new_v4(), Uuid::new_v4(), "key-1", 1),
    ] {
        sqlx::query("INSERT INTO packages VALUES($1,$2)")
            .bind(package)
            .bind(owner)
            .execute(&pool)
            .await
            .unwrap();
        let release = Uuid::new_v4();
        sqlx::query("INSERT INTO releases VALUES($1,$2)")
            .bind(release)
            .bind(package)
            .execute(&pool)
            .await
            .unwrap();
        for _ in 0..count {
            sqlx::query("INSERT INTO artifacts VALUES($1,$2,jsonb_build_object('keyId',$3::text))")
                .bind(Uuid::new_v4())
                .bind(release)
                .bind(key)
                .execute(&pool)
                .await
                .unwrap();
        }
    }
    let principal = PrincipalRef {
        issuer: "test-issuer".into(),
        subject: "test-subject".into(),
    };
    let mut tx = pool.begin().await.unwrap();
    sqlx::query("SET LOCAL statement_timeout='3s'")
        .execute(&mut *tx)
        .await
        .unwrap();
    emit_revocation(&mut tx, &principal, publisher, "key-1")
        .await
        .unwrap();
    let timeout: String = sqlx::query_scalar("SHOW statement_timeout")
        .fetch_one(&mut *tx)
        .await
        .unwrap();
    assert_eq!(timeout, "3s");
    let rows: Vec<(Uuid, String, Uuid, serde_json::Value)> =
        sqlx::query_as("SELECT id,subject,aggregate_id,payload FROM outbox_events")
            .fetch_all(&mut *tx)
            .await
            .unwrap();
    assert_eq!(
        rows.len(),
        1,
        "one event per package, not artifact; no cross-key/tenant event"
    );
    assert_eq!(rows[0].1, "assetlibrary.catalog.invalidated.v1");
    assert_eq!(rows[0].2, affected);
    let event: CatalogInvalidated = serde_json::from_value(rows[0].3.clone()).unwrap();
    assert!(event.validate());
    assert_eq!(event.event_id, rows[0].0);
    assert_eq!(event.package_id, affected);
    assert_eq!(
        event.reason,
        assetlibrary_contracts::CatalogInvalidationReason::SigningKeyRevoked
    );
    tx.rollback().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(
        count, 0,
        "invalidation rolls back with revoke, not an external side effect"
    );
    let mut tx = pool.begin().await.unwrap();
    emit_revocation(&mut tx, &principal, publisher, "missing-key")
        .await
        .unwrap();
    tx.commit().await.unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM outbox_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 0);
    pool.close().await;
}
