use super::*;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use std::{str::FromStr, time::Duration};

#[tokio::test]
#[ignore = "requires explicitly selected disposable loopback PostgreSQL"]
async fn edge_policy_repository_gate() {
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
        CREATE TEMP TABLE packages(id uuid PRIMARY KEY,publisher_id uuid);
        CREATE TEMP TABLE releases(id uuid PRIMARY KEY,package_id uuid);
        CREATE TEMP TABLE artifacts(id uuid PRIMARY KEY,release_id uuid,signature jsonb);
        CREATE TEMP TABLE publisher_signing_keys(publisher_id uuid,key_id text,status text);
        CREATE TEMP TABLE projection_events(projection text,event_id uuid,aggregate_id uuid,
            PRIMARY KEY(projection,event_id));
    "#,
    )
    .execute(&pool)
    .await
    .unwrap();
    let publisher = Uuid::new_v4();
    let package = Uuid::new_v4();
    let release = Uuid::new_v4();
    sqlx::query("INSERT INTO packages VALUES($1,$2)")
        .bind(package)
        .bind(publisher)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO releases VALUES($1,$2)")
        .bind(release)
        .bind(package)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("INSERT INTO publisher_signing_keys SELECT $1,'used-'||lpad(i::text,4,'0'),'revoked' FROM generate_series(1,1001)i")
        .bind(publisher).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO publisher_signing_keys SELECT $1,'unrelated-'||i::text,'revoked' FROM generate_series(1,1001)i")
        .bind(publisher).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO publisher_signing_keys VALUES($1,'active','active'),($2,'used-0001','revoked')")
        .bind(publisher).bind(Uuid::new_v4()).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO artifacts SELECT gen_random_uuid(),$1,jsonb_build_object('keyId',key_id) FROM publisher_signing_keys WHERE publisher_id=$2 AND key_id NOT LIKE 'unrelated-%'")
        .bind(release).bind(publisher).execute(&pool).await.unwrap();
    let repository = Repository::new(pool.clone());
    let mut keys = Vec::new();
    let mut after = None;
    loop {
        let page = repository
            .revoked_signing_keys(package, after.as_deref())
            .await
            .unwrap();
        assert!(page.len() <= 200);
        if page.is_empty() {
            break;
        }
        assert!(
            page.iter()
                .all(|(key, owner)| key.starts_with("used-") && *owner == publisher)
        );
        after = page.last().map(|value| value.0.clone());
        keys.extend(page);
    }
    assert_eq!(
        keys.len(),
        1001,
        "no truncation at reversible-state 1000 key limit"
    );
    assert!(keys.windows(2).all(|pair| pair[0].0 < pair[1].0));
    assert!(
        repository
            .is_irreversible_key_revocation(
                package,
                &format!("revoked:signing_key:{publisher}:used-0001")
            )
            .await
            .unwrap()
    );
    assert!(
        !repository
            .is_irreversible_key_revocation(
                package,
                &format!("revoked:signing_key:{publisher}:active")
            )
            .await
            .unwrap()
    );
    let event = Uuid::new_v4();
    repository
        .mark_processed("edge-policy-v1", event, package)
        .await
        .unwrap();
    assert!(
        repository
            .was_processed("edge-policy-v1", event)
            .await
            .unwrap()
    );
    assert!(
        !repository
            .was_processed("search-edge-v1", event)
            .await
            .unwrap()
    );
    repository
        .mark_processed("search-edge-v1", event, package)
        .await
        .unwrap();
    repository
        .mark_processed("edge-policy-v1", event, package)
        .await
        .unwrap();
    let count: i64 = sqlx::query_scalar("SELECT count(*) FROM projection_events")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(count, 2);
    pool.close().await;
}
