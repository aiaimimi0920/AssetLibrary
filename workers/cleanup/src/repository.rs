use serde_json::json;
use sqlx::{PgPool, Row};
use uuid::Uuid;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CleanupKind {
    ExpiredUpload,
    TerminalQuarantine,
}

pub struct CleanupCandidate {
    pub session_id: Uuid,
    pub release_id: Uuid,
    pub artifact_id: Uuid,
    pub object_key: String,
    pub upload_id: Option<String>,
    pub kind: CleanupKind,
}

pub async fn claim(
    pool: &PgPool,
    worker_id: &str,
    batch_size: i64,
    claim_timeout_seconds: i64,
    terminal_retention_seconds: i64,
) -> Result<Vec<CleanupCandidate>, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let rows = sqlx::query(
        "SELECT us.id, us.release_id, us.artifact_id, us.object_key, us.storage_upload_id, a.status \
         FROM upload_sessions us JOIN artifacts a ON a.id=us.artifact_id \
         WHERE us.cleaned_at IS NULL AND us.cleanup_attempts < 20 \
           AND (us.cleanup_claimed_at IS NULL OR us.cleanup_claimed_at < now() - ($2 * interval '1 second')) \
           AND ((us.expires_at <= now() AND a.status IN ('pending_upload','uploaded','deleted')) \
             OR (a.status IN ('verified','quarantined') \
                 AND a.updated_at <= now() - ($3 * interval '1 second'))) \
         ORDER BY us.expires_at, us.id FOR UPDATE OF us, a SKIP LOCKED LIMIT $1",
    )
    .bind(batch_size)
    .bind(claim_timeout_seconds)
    .bind(terminal_retention_seconds)
    .fetch_all(&mut *transaction)
    .await?;

    let mut candidates = Vec::with_capacity(rows.len());
    for row in rows {
        let status: String = row.try_get("status")?;
        let kind = match status.as_str() {
            "verified" | "quarantined" => CleanupKind::TerminalQuarantine,
            _ => CleanupKind::ExpiredUpload,
        };
        let artifact_id = row.try_get("artifact_id")?;
        if kind == CleanupKind::ExpiredUpload {
            sqlx::query(
                "UPDATE artifacts SET status='deleted' WHERE id=$1 \
                 AND status IN ('pending_upload','uploaded','deleted')",
            )
            .bind(artifact_id)
            .execute(&mut *transaction)
            .await?;
        }
        let session_id = row.try_get("id")?;
        let session_status = if kind == CleanupKind::ExpiredUpload {
            "deleted"
        } else {
            status.as_str()
        };
        sqlx::query(
            "UPDATE upload_sessions SET status=$2, cleanup_claimed_at=now(), cleanup_worker=$3, \
                    cleanup_attempts=cleanup_attempts+1, cleanup_error=NULL WHERE id=$1",
        )
        .bind(session_id)
        .bind(session_status)
        .bind(worker_id)
        .execute(&mut *transaction)
        .await?;
        candidates.push(CleanupCandidate {
            session_id,
            release_id: row.try_get("release_id")?,
            artifact_id,
            object_key: row.try_get("object_key")?,
            upload_id: row.try_get("storage_upload_id")?,
            kind,
        });
    }
    transaction.commit().await?;
    Ok(candidates)
}

pub async fn complete(
    pool: &PgPool,
    candidate: &CleanupCandidate,
    worker_id: &str,
) -> Result<bool, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let updated = sqlx::query(
        "UPDATE upload_sessions SET cleaned_at=now(), cleanup_claimed_at=NULL, cleanup_worker=NULL, cleanup_error=NULL \
         WHERE id=$1 AND cleanup_worker=$2 AND cleaned_at IS NULL",
    )
    .bind(candidate.session_id)
    .bind(worker_id)
    .execute(&mut *transaction)
    .await?
    .rows_affected();
    if updated == 0 {
        transaction.rollback().await?;
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO audit_events (actor_issuer, actor_subject, action, resource_type, \
          resource_id, correlation_id, details) \
         VALUES ('assetlibrary:system', 'cleanup-worker', 'artifact.quarantine.cleaned', \
          'artifact', $1, $2, $3)",
    )
    .bind(candidate.artifact_id)
    .bind(worker_id)
    .bind(json!({
        "release_id": candidate.release_id.to_string(),
        "object_key": candidate.object_key,
        "kind": match candidate.kind {
            CleanupKind::ExpiredUpload => "expired_upload",
            CleanupKind::TerminalQuarantine => "terminal_quarantine",
        }
    }))
    .execute(&mut *transaction)
    .await?;
    transaction.commit().await?;
    Ok(true)
}

pub async fn fail(
    pool: &PgPool,
    session_id: Uuid,
    worker_id: &str,
    failure_code: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "UPDATE upload_sessions SET cleanup_claimed_at=NULL, cleanup_worker=NULL, cleanup_error=$3 \
         WHERE id=$1 AND cleanup_worker=$2 AND cleaned_at IS NULL",
    )
    .bind(session_id)
    .bind(worker_id)
    .bind(failure_code)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn multipart_is_referenced(
    pool: &PgPool,
    object_key: &str,
    upload_id: &str,
) -> Result<bool, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM upload_sessions WHERE object_key=$1 \
         AND storage_upload_id=$2 AND cleaned_at IS NULL)",
    )
    .bind(object_key)
    .bind(upload_id)
    .fetch_one(pool)
    .await
}

pub async fn record_orphan_abort(
    pool: &PgPool,
    release_id: Uuid,
    artifact_id: Uuid,
    worker_id: &str,
    object_key: &str,
    initiated_epoch_seconds: i64,
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO audit_events (actor_issuer, actor_subject, action, resource_type, \
          resource_id, correlation_id, details) VALUES \
         ('assetlibrary:system','cleanup-worker','multipart.orphan.aborted','artifact',$1,$2,$3)",
    )
    .bind(artifact_id)
    .bind(worker_id)
    .bind(json!({
        "release_id": release_id.to_string(),
        "object_key": object_key,
        "initiated_epoch_seconds": initiated_epoch_seconds,
    }))
    .execute(pool)
    .await?;
    Ok(())
}
