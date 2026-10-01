use crate::catalog::{CatalogError, PUBLIC_PACKAGE_ELIGIBILITY};
use assetlibrary_contracts::{SCHEMA_VERSION_V1, SITEMAP_MAX_SLUGS, SitemapManifest, SitemapShard};
use sqlx::{PgPool, Postgres, Transaction};
use std::time::Duration;
use uuid::Uuid;

const DATABASE_DEADLINE: Duration = Duration::from_secs(2);

// UUID byte order defines inclusive, disjoint intervals, including nil and MAX.
// Bounds never depend on publication time, page size, or catalog mutations.
pub(crate) fn bounds(shard: u8) -> (Uuid, Uuid) {
    let lower = u128::from(shard) << 120;
    (
        Uuid::from_u128(lower),
        Uuid::from_u128(lower | (u128::MAX >> 8)),
    )
}

fn manifest_query() -> String {
    format!(
        "WITH occupied AS MATERIALIZED (SELECT shard, EXISTS (\
         SELECT 1 {PUBLIC_PACKAGE_ELIGIBILITY}\
         AND p.id >= (lpad(to_hex(shard), 2, '0') || repeat('0', 30))::uuid \
         AND p.id <= (lpad(to_hex(shard), 2, '0') || repeat('f', 30))::uuid\
         ) AS present FROM generate_series(0, 255) bounds(shard)) \
         SELECT shard FROM occupied WHERE present ORDER BY shard"
    )
}

fn shard_query() -> String {
    format!(
        "SELECT p.slug::text {PUBLIC_PACKAGE_ELIGIBILITY} \
         AND p.id >= $1 AND p.id <= $2 ORDER BY p.id LIMIT $3"
    )
}

async fn transaction(pool: &PgPool) -> Result<Transaction<'_, Postgres>, CatalogError> {
    let mut tx = pool.begin().await.map_err(CatalogError::Database)?;
    // The database also cancels work if an HTTP caller or client deadline drops
    // its future. LOCAL cannot leak this setting into unrelated pooled queries.
    sqlx::query("SET LOCAL statement_timeout = '1500ms'")
        .execute(&mut *tx)
        .await
        .map_err(CatalogError::Database)?;
    Ok(tx)
}

pub(crate) async fn manifest(pool: &PgPool) -> Result<Vec<String>, CatalogError> {
    tokio::time::timeout(DATABASE_DEADLINE, async {
        let mut tx = transaction(pool).await?;
        let rows = sqlx::query_scalar::<_, i32>(&manifest_query())
            .fetch_all(&mut *tx)
            .await
            .map_err(CatalogError::Database)?;
        let value = SitemapManifest {
            schema_version: SCHEMA_VERSION_V1.into(),
            shards: rows.into_iter().map(|id| format!("{id:02x}")).collect(),
        };
        if !value.validate() {
            tracing::warn!(reason = "invalid_manifest", "public sitemap unavailable");
            return Err(CatalogError::Unavailable);
        }
        tx.commit().await.map_err(CatalogError::Database)?;
        Ok(value.shards)
    })
    .await
    .map_err(|_| CatalogError::Unavailable)?
}

pub(crate) async fn shard(pool: &PgPool, shard: u8) -> Result<Vec<String>, CatalogError> {
    tokio::time::timeout(DATABASE_DEADLINE, async {
        let mut tx = transaction(pool).await?;
        let (lower, upper) = bounds(shard);
        let slugs = sqlx::query_scalar::<_, String>(&shard_query())
            .bind(lower)
            .bind(upper)
            .bind((SITEMAP_MAX_SLUGS + 1) as i64)
            .fetch_all(&mut *tx)
            .await
            .map_err(CatalogError::Database)?;
        let value = SitemapShard {
            schema_version: SCHEMA_VERSION_V1.into(),
            shard: format!("{shard:02x}"),
            slugs,
        };
        // Never emit a successful truncated leaf or omit malformed public rows.
        if !value.validate() {
            let reason = if value.slugs.len() > SITEMAP_MAX_SLUGS {
                "shard_capacity"
            } else {
                "invalid_projection"
            };
            tracing::warn!(reason, shard, "public sitemap unavailable");
            return Err(CatalogError::Unavailable);
        }
        tx.commit().await.map_err(CatalogError::Database)?;
        Ok(value.slugs)
    })
    .await
    .map_err(|_| CatalogError::Unavailable)?
}

#[cfg(test)]
#[path = "sitemap_postgres_tests.rs"]
mod postgres_tests;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sitemap_intervals_cover_every_uuid_once() {
        let mut previous = None;
        for shard in 0..=255 {
            let (lower, upper) = bounds(shard);
            assert_eq!(lower.as_bytes()[0], shard);
            assert_eq!(upper.as_bytes()[0], shard);
            assert_eq!(upper.as_u128() - lower.as_u128(), u128::MAX >> 8);
            if let Some(previous) = previous {
                assert_eq!(lower.as_u128(), previous + 1);
            } else {
                assert_eq!(lower, Uuid::nil());
            }
            previous = Some(upper.as_u128());
        }
        assert_eq!(previous, Some(u128::MAX));
    }

    #[test]
    fn sitemap_queries_share_the_catalog_gate_and_keep_uuid_index_conditions() {
        for query in [manifest_query(), shard_query()] {
            assert!(query.contains(PUBLIC_PACKAGE_ELIGIBILITY));
            assert!(query.contains("p.id >="));
            assert!(query.contains("p.id <="));
            assert!(!query.contains("p.id::text LIKE"));
            assert!(!query.contains("OFFSET"));
            assert!(!query.contains("COUNT("));
            assert!(!query.contains("p.updated_at"));
        }
        assert_eq!(manifest_query().matches("FROM packages p").count(), 1);
        assert!(manifest_query().contains("generate_series(0, 255)"));
    }
}
