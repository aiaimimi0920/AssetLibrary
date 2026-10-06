//! Local test seam: reuse production projection SQL and policy reconciliation.
//! This is not the NATS indexer or evidence of automatic cloud propagation.
#[allow(dead_code)]
#[path = "../src/config.rs"]
mod config;
#[path = "../src/edge_policy.rs"]
mod edge_policy;
#[allow(dead_code)]
#[path = "../src/repository.rs"]
mod repository;

use config::EdgePolicyConfig;
use edge_policy::EdgePolicy;
use repository::Repository;
use reqwest::Url;
use sqlx::postgres::PgPoolOptions;
use std::{env, time::Duration};
use uuid::Uuid;

fn required(name: &str) -> Result<String, &'static str> {
    env::var(name).map_err(|_| "missing local-test setting")
}

fn local_url(value: &str, database: bool) -> Result<Url, &'static str> {
    let url = Url::parse(value).map_err(|_| "invalid local-test URL")?;
    let scheme = if database { "postgres" } else { "http" };
    if url.scheme() != scheme
        || url.host_str() != Some("127.0.0.1")
        || url.port().is_none()
        || url.query().is_some()
        || url.fragment().is_some()
        || (database && (url.path() != "/assetlibrary" || url.username() != "assetlibrary"))
        || (!database
            && (url.path() != "/" || !url.username().is_empty() || url.password().is_some()))
    {
        return Err("refusing nonloopback or unexpected local-test endpoint");
    }
    Ok(url)
}

async fn reconcile() -> Result<(), &'static str> {
    if required("ART_ISOLATED_TEST")? != "true" {
        return Err("explicit isolated-test marker required");
    }
    let database = required("DATABASE_URL")?;
    local_url(&database, true)?;
    let api_base = local_url(&required("ART_POLICY_ORIGIN")?, false)?;
    let api_token = required("ART_POLICY_TOKEN")?;
    if api_token.len() != 48 || !api_token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("invalid local-test policy token");
    }
    let package_id =
        Uuid::parse_str(&required("ART_PACKAGE_ID")?).map_err(|_| "invalid package ID")?;
    let pool = PgPoolOptions::new()
        .max_connections(2)
        .acquire_timeout(Duration::from_secs(3))
        .after_connect(|connection, _| {
            Box::pin(async move {
                sqlx::query("SET statement_timeout='3000ms'")
                    .execute(&mut *connection)
                    .await?;
                sqlx::query("SET lock_timeout='1000ms'")
                    .execute(&mut *connection)
                    .await?;
                Ok(())
            })
        })
        .connect(&database)
        .await
        .map_err(|_| "local-test database connection failed")?;
    let repository = Repository::new(pool.clone());
    let guard = repository
        .projection_guard()
        .await
        .map_err(|_| "projection guard failed")?;
    let document = repository
        .document(package_id)
        .await
        .map_err(|_| "document projection failed")?;
    let policy = EdgePolicy::new(EdgePolicyConfig {
        api_base,
        account_id: "a".repeat(32),
        namespace_id: "b".repeat(32),
        api_token,
    })
    .map_err(|_| "policy client creation failed")?;
    policy
        .reconcile(&repository, package_id, document.as_ref())
        .await
        .map_err(|_| "policy reconciliation failed")?;
    guard
        .commit()
        .await
        .map_err(|_| "projection guard commit failed")?;
    pool.close().await;
    println!(
        "{}",
        serde_json::json!({"package_id":package_id,"eligible":document.is_some(),
        "digest":document.as_ref().map(|value| &value.digest)})
    );
    Ok(())
}

#[tokio::main]
async fn main() {
    let result = tokio::time::timeout(Duration::from_secs(20), reconcile()).await;
    if !matches!(result, Ok(Ok(()))) {
        eprintln!("Local policy test reconciliation failed or timed out");
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::local_url;

    #[test]
    fn endpoints_are_explicit_loopback_only() {
        assert!(
            local_url(
                "postgres://assetlibrary:test@127.0.0.1:5433/assetlibrary",
                true
            )
            .is_ok()
        );
        assert!(local_url("http://127.0.0.1:8001/", false).is_ok());
        for value in [
            "https://example.com",
            "http://localhost:8001",
            "http://127.0.0.1",
            "http://token@127.0.0.1:8001",
            "http://127.0.0.1:8001/path",
            "http://127.0.0.1:8001/?x=1",
        ] {
            assert!(local_url(value, false).is_err());
        }
        assert!(
            local_url(
                "postgres://assetlibrary:test@127.0.0.1:5433/production",
                true
            )
            .is_err()
        );
    }
}
