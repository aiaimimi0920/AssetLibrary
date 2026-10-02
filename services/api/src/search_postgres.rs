//! Optional small-catalog search. No cache, external index, or package bytes.
use assetlibrary_contracts::PackageKind;
use async_trait::async_trait;
use sqlx::{Connection, PgPool};

#[path = "search_connection.rs"]
mod connection;
use std::time::{Duration, Instant};

use crate::{
    catalog::{PUBLIC_PACKAGE_COLUMNS, PUBLIC_PACKAGE_ELIGIBILITY, PackageRow, into_contract},
    search::{SearchError, SearchFilter, SearchRepository, SearchResult},
    search_cursor,
};

const SEARCH_DEADLINE: Duration = Duration::from_secs(2);

pub struct PostgresSearchRepository {
    pool: PgPool,
}

impl PostgresSearchRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    async fn query(&self, filter: &SearchFilter) -> Result<SearchResult, SearchError> {
        let cursor = search_cursor::decode(filter)?;
        let kind = filter.kind.as_ref().map(|kind| match kind {
            PackageKind::Art => "art",
            PackageKind::Capability => "capability",
            PackageKind::AppUpdate => "app_update",
        });
        // A server-side statement timeout also bounds work if the request future
        // is cancelled. SET LOCAL cannot leak this policy to a pooled borrower.
        let mut connection = connection::SearchConnection::acquire(&self.pool)
            .await
            .map_err(|_| SearchError::Unavailable)?;
        let mut transaction = connection
            .connection()
            .begin()
            .await
            .map_err(|_| SearchError::Unavailable)?;
        for statement in [
            "SET TRANSACTION READ ONLY",
            "SET LOCAL statement_timeout = '1500ms'",
            "SET LOCAL lock_timeout = '1000ms'",
        ] {
            sqlx::query(statement)
                .execute(&mut *transaction)
                .await
                .map_err(|_| SearchError::Unavailable)?;
        }
        let sql = format!(
            "{PUBLIC_PACKAGE_COLUMNS} {PUBLIC_PACKAGE_ELIGIBILITY} \
             AND ($1::text IS NULL OR strpos(lower(p.name), lower($1)) > 0 \
               OR strpos(lower(p.summary), lower($1)) > 0 \
               OR strpos(lower(p.description), lower($1)) > 0 \
               OR strpos(lower(publisher.display_name), lower($1)) > 0) \
             AND ($2::text IS NULL OR p.kind = $2) \
             AND ($3::text IS NULL OR p.tags @> ARRAY[$3]::text[]) \
             AND ($4::timestamptz IS NULL OR p.updated_at < $4 \
               OR (p.updated_at = $4 AND p.id > $5)) \
             ORDER BY p.updated_at DESC, p.id ASC LIMIT $6"
        );
        let limit = filter.limit.clamp(1, 100);
        let mut rows = sqlx::query_as::<_, PackageRow>(&sql)
            .bind(filter.query.as_deref())
            .bind(kind)
            .bind(filter.tag.as_deref())
            .bind(cursor.as_ref().map(|value| value.updated_at))
            .bind(cursor.as_ref().map(|value| value.package_id))
            .bind(i64::from(limit) + 1)
            .fetch_all(&mut *transaction)
            .await
            .map_err(|_| SearchError::Unavailable)?;
        transaction
            .commit()
            .await
            .map_err(|_| SearchError::Unavailable)?;
        connection.release();
        let has_more = rows.len() > usize::from(limit);
        rows.truncate(usize::from(limit));
        let next_cursor = if has_more {
            rows.last()
                .map(|row| search_cursor::encode(filter, row.9, row.0))
                .transpose()?
        } else {
            None
        };
        let items = rows
            .into_iter()
            .map(|row| into_contract(row).ok_or(SearchError::InvalidProjection))
            .collect::<Result<_, _>>()?;
        Ok(SearchResult { items, next_cursor })
    }
}

#[async_trait]
impl SearchRepository for PostgresSearchRepository {
    async fn search(&self, filter: &SearchFilter) -> Result<SearchResult, SearchError> {
        let started = Instant::now();
        let result = tokio::time::timeout(SEARCH_DEADLINE, self.query(filter)).await;
        let (outcome, result) = match result {
            Ok(Ok(result)) => ("success", Ok(result)),
            Ok(Err(error)) => ("error", Err(error)),
            Err(_) => ("timeout", Err(SearchError::Unavailable)),
        };
        assetlibrary_telemetry::record_dependency(
            "postgres",
            "catalog_search",
            outcome,
            started.elapsed(),
        );
        result
    }
}

#[cfg(test)]
#[path = "search_postgres_tests.rs"]
mod tests;
