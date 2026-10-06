use assetlibrary_contracts::{
    LibraryEntry, LibraryEntryStatus, PackageKind, PackageStatus, PublishedPackage,
    PublisherSummary, UpdateLibraryEntryRequest,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::PgPool;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef,
    workflow::{WorkflowError, idempotency},
};

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
pub struct LibraryCursor {
    pub updated_at_micros: i64,
    pub package_id: Uuid,
}

#[async_trait]
pub trait LibraryRepository: Send + Sync {
    async fn list(
        &self,
        principal: &PrincipalRef,
        cursor: Option<LibraryCursor>,
        limit: u16,
    ) -> Result<(Vec<LibraryEntry>, Option<LibraryCursor>), WorkflowError>;
    async fn update(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &UpdateLibraryEntryRequest,
    ) -> Result<LibraryEntry, WorkflowError>;
}

pub struct PostgresLibraryRepository {
    pool: PgPool,
}

impl PostgresLibraryRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[derive(Default)]
pub struct UnavailableLibraryRepository;

type EntryRow = (
    Uuid,
    String,
    String,
    String,
    String,
    String,
    Uuid,
    String,
    String,
    String,
    bool,
    Option<Uuid>,
    Option<Uuid>,
    i64,
);

const ENTRY_COLUMNS: &str = r#"
SELECT p.id,p.slug::text,p.name,p.kind,p.status,p.summary,
       publisher.id,publisher.slug::text,publisher.display_name,
       le.status,le.favorite,le.installed_release_id,le.installed_artifact_id,
       (extract(epoch FROM le.updated_at) * 1000000)::bigint
FROM library_entries le
JOIN packages p ON p.id=le.package_id
JOIN publishers publisher ON publisher.id=p.publisher_id
"#;

#[async_trait]
impl LibraryRepository for PostgresLibraryRepository {
    async fn list(
        &self,
        principal: &PrincipalRef,
        cursor: Option<LibraryCursor>,
        limit: u16,
    ) -> Result<(Vec<LibraryEntry>, Option<LibraryCursor>), WorkflowError> {
        let take = i64::from(limit.clamp(1, 100)) + 1;
        let query = format!(
            "{ENTRY_COLUMNS} WHERE le.principal_issuer=$1 AND le.principal_subject=$2 \
             AND le.status<>'removed' AND p.status IN ('published','suspended','archived') \
             AND ($3::bigint IS NULL OR (le.updated_at,le.package_id) < \
             (to_timestamp($3::double precision / 1000000),$4)) \
             ORDER BY le.updated_at DESC,le.package_id DESC LIMIT $5"
        );
        let rows = sqlx::query_as::<_, EntryRow>(&query)
            .bind(&principal.issuer)
            .bind(&principal.subject)
            .bind(cursor.map(|value| value.updated_at_micros))
            .bind(cursor.map(|value| value.package_id))
            .bind(take)
            .fetch_all(&self.pool)
            .await
            .map_err(|_| WorkflowError::Database)?;
        let has_more = rows.len() == usize::try_from(take).unwrap_or(usize::MAX);
        let mut items = rows
            .into_iter()
            .take(usize::from(limit.clamp(1, 100)))
            .map(entry)
            .collect::<Result<Vec<_>, _>>()?;
        let next = if has_more {
            items.last().and_then(|item| {
                timestamp_micros(&item.updated_at).map(|updated_at_micros| LibraryCursor {
                    updated_at_micros,
                    package_id: item.package.id,
                })
            })
        } else {
            None
        };
        items.shrink_to_fit();
        Ok((items, next))
    }

    async fn update(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &UpdateLibraryEntryRequest,
    ) -> Result<LibraryEntry, WorkflowError> {
        let operation = "library.update";
        let digest = idempotency::request_digest(operation, &package_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        if let Some(replay) =
            idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(replay);
        }
        let accessible = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM packages p WHERE p.id=$1 \
             AND p.status IN ('published','suspended','archived') AND \
             (p.visibility<>'private' OR EXISTS(SELECT 1 FROM publisher_members pm \
             WHERE pm.publisher_id=p.publisher_id AND pm.principal_issuer=$2 \
             AND pm.principal_subject=$3 AND pm.status='active'))) \
             AND ($4::uuid IS NULL OR EXISTS(SELECT 1 FROM releases r \
             JOIN published_release_artifacts published ON published.release_id=r.id \
             JOIN artifacts a ON a.release_id=r.id AND a.id=published.artifact_id \
             WHERE r.id=$4 AND a.id=$5 AND r.package_id=$1 AND a.status='verified'))",
        )
        .bind(package_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .bind(request.installed_release_id)
        .bind(request.installed_artifact_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        if !accessible {
            return Err(WorkflowError::NotFound);
        }
        sqlx::query(
            "INSERT INTO library_entries (principal_issuer,principal_subject,package_id,status, \
             favorite,installed_release_id,installed_artifact_id) VALUES ($1,$2,$3,$4,$5,$6,$7) \
             ON CONFLICT (principal_issuer,principal_subject,package_id) DO UPDATE SET \
             status=EXCLUDED.status,favorite=EXCLUDED.favorite,installed_release_id=EXCLUDED.installed_release_id, \
             installed_artifact_id=EXCLUDED.installed_artifact_id",
        )
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .bind(package_id)
        .bind(status_text(request.status))
        .bind(request.favorite)
        .bind(request.installed_release_id)
        .bind(request.installed_artifact_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        let query = format!(
            "{ENTRY_COLUMNS} WHERE le.principal_issuer=$1 AND le.principal_subject=$2 AND le.package_id=$3"
        );
        let result = entry(
            sqlx::query_as::<_, EntryRow>(&query)
                .bind(&principal.issuer)
                .bind(&principal.subject)
                .bind(package_id)
                .fetch_one(&mut *tx)
                .await
                .map_err(|_| WorkflowError::Database)?,
        )?;
        sqlx::query("INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id,correlation_id,details) VALUES ($1,$2,'library.updated','package',$3,$4,$5)")
            .bind(&principal.issuer).bind(&principal.subject).bind(package_id).bind(request_id)
            .bind(json!({"status": status_text(request.status), "favorite": request.favorite}))
            .execute(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }
}

#[async_trait]
impl LibraryRepository for UnavailableLibraryRepository {
    async fn list(
        &self,
        _: &PrincipalRef,
        _: Option<LibraryCursor>,
        _: u16,
    ) -> Result<(Vec<LibraryEntry>, Option<LibraryCursor>), WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn update(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &UpdateLibraryEntryRequest,
    ) -> Result<LibraryEntry, WorkflowError> {
        Err(WorkflowError::Database)
    }
}

fn entry(row: EntryRow) -> Result<LibraryEntry, WorkflowError> {
    let kind = match row.3.as_str() {
        "art" => PackageKind::Art,
        "capability" => PackageKind::Capability,
        "app_update" => PackageKind::AppUpdate,
        _ => return Err(WorkflowError::Database),
    };
    let package_status = match row.4.as_str() {
        "published" => PackageStatus::Published,
        "suspended" => PackageStatus::Suspended,
        "archived" => PackageStatus::Archived,
        _ => return Err(WorkflowError::Database),
    };
    let status = match row.9.as_str() {
        "listed" => LibraryEntryStatus::Listed,
        "hidden" => LibraryEntryStatus::Hidden,
        "removed" => LibraryEntryStatus::Removed,
        _ => return Err(WorkflowError::Database),
    };
    Ok(LibraryEntry {
        package: PublishedPackage {
            id: row.0,
            slug: row.1,
            name: row.2,
            kind,
            publisher: PublisherSummary {
                id: row.6,
                slug: row.7,
                display_name: row.8,
            },
            status: package_status,
            summary: row.5,
        },
        status,
        favorite: row.10,
        installed_release_id: row.11,
        installed_artifact_id: row.12,
        updated_at: format_micros(row.13)?,
    })
}

fn status_text(status: LibraryEntryStatus) -> &'static str {
    match status {
        LibraryEntryStatus::Listed => "listed",
        LibraryEntryStatus::Hidden => "hidden",
        LibraryEntryStatus::Removed => "removed",
    }
}

fn format_micros(value: i64) -> Result<String, WorkflowError> {
    OffsetDateTime::from_unix_timestamp_nanos(i128::from(value) * 1_000)
        .map_err(|_| WorkflowError::Database)?
        .format(&Rfc3339)
        .map_err(|_| WorkflowError::Database)
}

fn timestamp_micros(value: &str) -> Option<i64> {
    let timestamp = OffsetDateTime::parse(value, &Rfc3339).ok()?;
    i64::try_from(timestamp.unix_timestamp_nanos() / 1_000).ok()
}
