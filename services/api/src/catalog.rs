use assetlibrary_contracts::{PackageKind, PackageStatus, PublishedPackage, PublisherSummary};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::time::Duration;
use time::OffsetDateTime;
use uuid::Uuid;

const PUBLIC_PACKAGE_COLUMNS: &str = r#"
SELECT p.id, p.slug::text, p.name, p.kind, p.status, p.summary,
       publisher.id, publisher.slug::text, publisher.display_name,
       p.updated_at
FROM packages p
JOIN publishers publisher ON publisher.id = p.publisher_id
WHERE p.status = 'published'
  AND p.visibility = 'public'
  AND publisher.status = 'active'
  AND NOT EXISTS (
      SELECT 1 FROM blocklist_entries b
      WHERE b.status = 'active'
        AND (b.target_type, b.target_ref) IN (
            ('publisher', publisher.id::text), ('package', p.id::text)
        )
  )
  AND EXISTS (
      SELECT 1
      FROM releases r
      JOIN published_release_artifacts published ON published.release_id = r.id
      JOIN artifacts a ON a.release_id = r.id AND a.id = published.artifact_id
      JOIN publisher_signing_keys key ON key.publisher_id = p.publisher_id
        AND key.key_id = a.signature->>'keyId'
        AND key.status = 'active'
      WHERE r.package_id = p.id
        AND r.status = 'published'
        AND a.status = 'verified'
        AND a.canonical_sha256 IS NOT NULL
        AND a.size_bytes IS NOT NULL
        AND a.media_type IS NOT NULL
        AND a.published_object_key = 'sha256/' || left(encode(a.canonical_sha256, 'hex'), 2)
          || '/' || encode(a.canonical_sha256, 'hex')
        AND NOT EXISTS (
            SELECT 1 FROM blocklist_entries b
            WHERE b.status = 'active'
              AND (b.target_type, b.target_ref) IN (
                  ('release', r.id::text), ('artifact', a.id::text)
                  , ('signing_key', p.publisher_id::text || ':' || key.key_id)
              )
        )
  )
"#;

#[derive(Debug)]
pub enum CatalogError {
    Database(sqlx::Error),
    Unavailable,
    ReadinessTimeout,
}

#[derive(Clone, Debug, Default)]
pub struct ListFilter {
    pub kind: Option<PackageKind>,
    pub publisher_slug: Option<String>,
    pub cursor: Option<CatalogCursor>,
    pub limit: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct CatalogCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub updated_at: OffsetDateTime,
    pub package_id: Uuid,
}

#[async_trait]
pub trait CatalogRepository: Send + Sync {
    async fn ready(&self) -> Result<(), CatalogError>;
    async fn list_published(
        &self,
        filter: &ListFilter,
    ) -> Result<(Vec<PublishedPackage>, Option<CatalogCursor>), CatalogError>;
    async fn find_published(&self, slug: &str) -> Result<Option<PublishedPackage>, CatalogError>;
}

pub struct PostgresCatalog {
    pool: PgPool,
}

#[derive(Default)]
pub struct DevelopmentCatalog;

#[async_trait]
impl CatalogRepository for DevelopmentCatalog {
    async fn ready(&self) -> Result<(), CatalogError> {
        Ok(())
    }

    async fn list_published(
        &self,
        _filter: &ListFilter,
    ) -> Result<(Vec<PublishedPackage>, Option<CatalogCursor>), CatalogError> {
        Ok((Vec::new(), None))
    }

    async fn find_published(&self, _slug: &str) -> Result<Option<PublishedPackage>, CatalogError> {
        Ok(None)
    }
}

impl PostgresCatalog {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl CatalogRepository for PostgresCatalog {
    async fn ready(&self) -> Result<(), CatalogError> {
        let Some(mut connection) = self.pool.try_acquire() else {
            return Err(CatalogError::Unavailable);
        };
        match tokio::time::timeout(
            Duration::from_secs(1),
            sqlx::query_scalar::<_, i32>("SELECT 1").fetch_one(&mut *connection),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(CatalogError::Database(error)),
            Err(_) => Err(CatalogError::ReadinessTimeout),
        }
    }

    async fn list_published(
        &self,
        filter: &ListFilter,
    ) -> Result<(Vec<PublishedPackage>, Option<CatalogCursor>), CatalogError> {
        let kind = filter.kind.as_ref().map(|value| match value {
            PackageKind::Art => "art",
            PackageKind::Capability => "capability",
            PackageKind::AppUpdate => "app_update",
        });
        let query = format!(
            "{PUBLIC_PACKAGE_COLUMNS} AND ($1::text IS NULL OR p.kind = $1) \
             AND ($2::text IS NULL OR publisher.slug = $2) \
             AND ($3::timestamptz IS NULL OR p.updated_at < $3 \
               OR (p.updated_at = $3 AND p.id > $4)) \
             ORDER BY p.updated_at DESC, p.id LIMIT $5"
        );
        let mut rows = sqlx::query_as::<_, PackageRow>(&query)
            .bind(kind)
            .bind(filter.publisher_slug.as_deref())
            .bind(filter.cursor.as_ref().map(|cursor| cursor.updated_at))
            .bind(filter.cursor.as_ref().map(|cursor| cursor.package_id))
            .bind(i64::from(filter.limit) + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(CatalogError::Database)?;
        let has_more = rows.len() > usize::from(filter.limit);
        rows.truncate(usize::from(filter.limit));
        let next = has_more.then(|| rows.last().map(row_cursor)).flatten();
        Ok((rows.into_iter().filter_map(into_contract).collect(), next))
    }

    async fn find_published(&self, slug: &str) -> Result<Option<PublishedPackage>, CatalogError> {
        let query = format!("{PUBLIC_PACKAGE_COLUMNS} AND p.slug = $1 LIMIT 1");
        let row = sqlx::query_as::<_, PackageRow>(&query)
            .bind(slug)
            .fetch_optional(&self.pool)
            .await
            .map_err(CatalogError::Database)?;
        Ok(row.and_then(into_contract))
    }
}

type PackageRow = (
    Uuid,
    String,
    String,
    String,
    String,
    String,
    Uuid,
    String,
    String,
    OffsetDateTime,
);

fn row_cursor(row: &PackageRow) -> CatalogCursor {
    CatalogCursor {
        updated_at: row.9,
        package_id: row.0,
    }
}

fn into_contract(row: PackageRow) -> Option<PublishedPackage> {
    let kind = match row.3.as_str() {
        "art" => PackageKind::Art,
        "capability" => PackageKind::Capability,
        "app_update" => PackageKind::AppUpdate,
        _ => return None,
    };
    let status = match row.4.as_str() {
        "published" => PackageStatus::Published,
        "suspended" => PackageStatus::Suspended,
        "archived" => PackageStatus::Archived,
        _ => return None,
    };
    Some(PublishedPackage {
        id: row.0,
        slug: row.1,
        name: row.2,
        kind,
        publisher: PublisherSummary {
            id: row.6,
            slug: row.7,
            display_name: row.8,
        },
        status,
        summary: row.5,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::postgres::PgPoolOptions;
    use std::time::Instant;

    #[tokio::test]
    async fn readiness_does_not_wait_for_a_new_pool_connection() {
        let pool = PgPoolOptions::new()
            .connect_lazy("postgresql://assetlibrary@127.0.0.1:9/assetlibrary")
            .expect("lazy pool configuration should parse");
        let started = Instant::now();
        let result = PostgresCatalog::new(pool).ready().await;
        assert!(matches!(result, Err(CatalogError::Unavailable)));
        assert!(started.elapsed() < Duration::from_millis(100));
    }
}
