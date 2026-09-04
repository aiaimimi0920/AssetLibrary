mod config;
mod repository;

use assetlibrary_object_store::{ObjectStore, S3ObjectStore};
use assetlibrary_telemetry::record_worker;
use config::Config;
use repository::{CleanupCandidate, CleanupKind};
use sqlx::postgres::PgPoolOptions;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tracing::{Instrument, error, info};
use uuid::Uuid;

type DynError = Box<dyn std::error::Error + Send + Sync>;

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let _telemetry = assetlibrary_telemetry::init(
        "assetlibrary-cleanup-worker",
        assetlibrary_telemetry::metrics_endpoint_from_env()?,
    )?;
    let config = Config::from_env()?;
    let pool = PgPoolOptions::new()
        .max_connections(4)
        .connect(&config.database_url)
        .await?;
    let _pool_metrics = assetlibrary_telemetry::monitor_postgres_pool(pool.clone(), "primary", 4);
    let store = S3ObjectStore::new(config.object_store.clone()).await?;
    let worker_id = Uuid::new_v4().to_string();
    let mut failures = 0usize;
    let mut claimed = 0usize;
    let operation_timeout = Duration::from_secs(
        u64::try_from(config.claim_timeout_seconds / 2)
            .map_err(|_| "cleanup claim timeout is invalid")?,
    );
    for _ in 0..config.batch_size {
        let Some(candidate) = repository::claim(
            &pool,
            &worker_id,
            1,
            config.claim_timeout_seconds,
            config.terminal_retention_seconds,
        )
        .await?
        .into_iter()
        .next() else {
            break;
        };
        claimed += 1;
        let started = Instant::now();
        let span = tracing::info_span!(
            "cleanup.object",
            release.id = %candidate.release_id,
            artifact.id = %candidate.artifact_id,
        );
        let result = tokio::time::timeout(
            operation_timeout,
            clean_candidate(&store, &candidate).instrument(span),
        )
        .await
        .unwrap_or(Err("cleanup_operation_timeout"));
        if let Err(failure_code) = result {
            record_worker("quarantine_cleanup", "failed", started.elapsed());
            failures += 1;
            repository::fail(&pool, candidate.session_id, &worker_id, failure_code).await?;
            error!(session_id = %candidate.session_id, failure_code, "quarantine cleanup failed");
            continue;
        }
        if !repository::complete(&pool, &candidate, &worker_id).await? {
            failures += 1;
            record_worker("quarantine_cleanup", "lease_lost", started.elapsed());
            error!(session_id = %candidate.session_id, "cleanup lease was lost before commit");
        } else {
            record_worker("quarantine_cleanup", "deleted", started.elapsed());
        }
    }
    let orphan_batch = usize::try_from(config.orphan_batch_size)
        .map_err(|_| "orphan multipart batch size is invalid")?;
    let orphan_aborted = cleanup_orphan_multiparts(
        &store,
        &pool,
        &worker_id,
        &config,
        orphan_batch,
        operation_timeout,
        &mut failures,
    )
    .await?;
    info!(
        claimed,
        orphan_aborted, failures, "quarantine cleanup batch completed"
    );
    if failures > 0 {
        return Err(format!("{failures} cleanup operations failed").into());
    }
    Ok(())
}

async fn cleanup_orphan_multiparts(
    store: &dyn ObjectStore,
    pool: &sqlx::PgPool,
    worker_id: &str,
    config: &Config,
    maximum_aborts: usize,
    operation_timeout: Duration,
    failures: &mut usize,
) -> Result<usize, DynError> {
    let scan_limit = usize::try_from(config.orphan_scan_limit)
        .map_err(|_| "orphan multipart scan limit is invalid")?;
    let uploads = tokio::time::timeout(
        operation_timeout,
        store.list_quarantine_multipart_uploads(scan_limit),
    )
    .await
    .map_err(|_| "orphan multipart listing timed out")??;
    let now = i64::try_from(SystemTime::now().duration_since(UNIX_EPOCH)?.as_secs())?;
    let cutoff = now.saturating_sub(config.orphan_grace_seconds);
    let mut aborted = 0usize;
    for upload in uploads {
        if aborted >= maximum_aborts || upload.initiated_epoch_seconds > cutoff {
            continue;
        }
        let Some((release_id, artifact_id)) = parse_object_key(&upload.object_key) else {
            *failures += 1;
            error!(object_key = %upload.object_key, "refusing to abort a non-canonical multipart key");
            continue;
        };
        if repository::multipart_is_referenced(pool, &upload.object_key, &upload.upload_id).await? {
            continue;
        }
        let result = tokio::time::timeout(
            operation_timeout,
            store.abort_quarantine_upload(&upload.object_key, &upload.upload_id),
        )
        .await;
        if !matches!(result, Ok(Ok(()))) {
            *failures += 1;
            error!(object_key = %upload.object_key, "orphan multipart abort failed");
            continue;
        }
        repository::record_orphan_abort(
            pool,
            release_id,
            artifact_id,
            worker_id,
            &upload.object_key,
            upload.initiated_epoch_seconds,
        )
        .await?;
        aborted += 1;
    }
    Ok(aborted)
}

async fn clean_candidate(
    store: &dyn ObjectStore,
    candidate: &CleanupCandidate,
) -> Result<(), &'static str> {
    if !valid_object_key(candidate) {
        return Err("invalid_quarantine_object_key");
    }
    if candidate.kind == CleanupKind::ExpiredUpload
        && let Some(upload_id) = &candidate.upload_id
    {
        store
            .abort_quarantine_upload(&candidate.object_key, upload_id)
            .await
            .map_err(|_| "multipart_abort_failed")?;
    }
    store
        .delete_quarantine_object(&candidate.object_key)
        .await
        .map_err(|_| "quarantine_delete_failed")
}

fn valid_object_key(candidate: &CleanupCandidate) -> bool {
    parse_object_key(&candidate.object_key) == Some((candidate.release_id, candidate.artifact_id))
}

fn parse_object_key(object_key: &str) -> Option<(Uuid, Uuid)> {
    let mut parts = object_key.split('/');
    if parts.next()? != "quarantine" {
        return None;
    }
    let release_id = Uuid::parse_str(parts.next()?).ok()?;
    let artifact_id = Uuid::parse_str(parts.next()?).ok()?;
    let name = parts.next()?;
    if parts.next().is_some()
        || name.is_empty()
        || name.len() > 240
        || name.starts_with('.')
        || !name.ends_with(".zip")
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-' | b'_'))
    {
        return None;
    }
    Some((release_id, artifact_id))
}

#[cfg(test)]
mod tests {
    use super::{CleanupCandidate, CleanupKind, valid_object_key};
    use uuid::Uuid;

    #[test]
    fn only_canonical_quarantine_keys_are_accepted() {
        let release_id = Uuid::new_v4();
        let artifact_id = Uuid::new_v4();
        let mut candidate = CleanupCandidate {
            session_id: Uuid::new_v4(),
            release_id,
            artifact_id,
            object_key: format!("quarantine/{release_id}/{artifact_id}/package.zip"),
            upload_id: None,
            kind: CleanupKind::ExpiredUpload,
        };
        assert!(valid_object_key(&candidate));
        candidate.object_key = format!("quarantine/{release_id}/{artifact_id}/../package.zip");
        assert!(!valid_object_key(&candidate));
        candidate.object_key = format!("quarantine/{release_id}/{}/package.zip", Uuid::new_v4());
        assert!(!valid_object_key(&candidate));
    }
}
