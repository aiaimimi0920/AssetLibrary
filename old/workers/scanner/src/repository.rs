mod transitions;

use assetlibrary_supply_chain::PackageKind;
use serde_json::Value;
use sqlx::{PgPool, Row};
use uuid::Uuid;

use crate::event::VerificationRequested;

pub const SCANNER_VERSION: &str = env!("CARGO_PKG_VERSION");
pub const RULE_VERSION: &str = "2026-09-03.1";
pub const MAX_PIPELINE_ATTEMPTS: i64 = 5;
pub const MAX_EVIDENCE_DELIVERIES: i64 = 20;

pub struct Repository {
    pub(super) pool: PgPool,
}

#[derive(Clone, Debug)]
pub struct ArtifactContext {
    pub artifact_id: Uuid,
    pub release_id: Uuid,
    pub package_id: Uuid,
    pub publisher_id: Uuid,
    pub object_key: String,
    pub size_bytes: u64,
    pub media_type: String,
    pub kind: PackageKind,
    pub package_slug: String,
    pub publisher_slug: String,
    pub version: String,
    pub permissions: Vec<String>,
}

pub enum Claim {
    Ready(ArtifactContext),
    Terminal,
    Discard,
}

pub struct VerifiedRecord {
    pub raw_sha256: [u8; 32],
    pub canonical_sha256: [u8; 32],
    pub published_object_key: String,
    pub manifest: Value,
    pub signature: Value,
    pub sbom_digest: [u8; 32],
    pub provenance_digest: [u8; 32],
}

impl Repository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn claim(
        &self,
        event: &VerificationRequested,
        delivery: i64,
    ) -> Result<Claim, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query(
            "SELECT a.status, a.object_key, a.size_bytes, a.media_type, a.scan_attempts, \
                    r.id, r.version, r.permissions, p.id, p.kind, p.slug::text, \
                    pub.id, pub.slug::text, us.expected_digest->>'value' \
             FROM artifacts a \
             JOIN upload_sessions us ON us.artifact_id = a.id \
             JOIN releases r ON r.id = a.release_id \
             JOIN packages p ON p.id = r.package_id \
             JOIN publishers pub ON pub.id = p.publisher_id \
             WHERE a.id = $1 FOR UPDATE OF a",
        )
        .bind(event.artifact_id)
        .fetch_optional(&mut *transaction)
        .await?;
        let Some(row) = row else {
            transaction.commit().await?;
            return Ok(Claim::Discard);
        };
        let status: String = row.try_get(0)?;
        if matches!(status.as_str(), "verified" | "quarantined" | "deleted") {
            transaction.commit().await?;
            return Ok(Claim::Terminal);
        }
        let object_key: String = row.try_get(1)?;
        let expected_digest: String = row.try_get(13)?;
        if !matches!(status.as_str(), "uploaded" | "scanning")
            || object_key != event.object_key
            || expected_digest != event.digest
            || row.try_get::<Uuid, _>(5)? != event.release_id
            || row.try_get::<Uuid, _>(8)? != event.package_id
        {
            transaction.commit().await?;
            return Ok(Claim::Discard);
        }
        let current_attempts: i32 = row.try_get(4)?;
        if current_attempts >= MAX_EVIDENCE_DELIVERIES as i32 {
            transaction.commit().await?;
            return Ok(Claim::Discard);
        }
        let inserted_attempt = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO artifact_scan_attempts \
             (artifact_id,event_id,delivery_count,result,scanner_version,rule_version) \
             VALUES ($1,$2,$3,'started',$4,$5) \
             ON CONFLICT (event_id,delivery_count) DO NOTHING RETURNING id",
        )
        .bind(event.artifact_id)
        .bind(event.event_id)
        .bind(i32::try_from(delivery).unwrap_or(20).clamp(1, 20))
        .bind(SCANNER_VERSION)
        .bind(RULE_VERSION)
        .fetch_optional(&mut *transaction)
        .await?;
        if inserted_attempt.is_some() {
            sqlx::query(
                "UPDATE artifacts SET status = 'scanning', scan_attempts = scan_attempts + 1, \
                        last_scan_error = NULL WHERE id = $1",
            )
            .bind(event.artifact_id)
            .execute(&mut *transaction)
            .await?;
        } else {
            let attempted_artifact = sqlx::query_scalar::<_, Uuid>(
                "SELECT artifact_id FROM artifact_scan_attempts \
                 WHERE event_id=$1 AND delivery_count=$2",
            )
            .bind(event.event_id)
            .bind(i32::try_from(delivery).unwrap_or(20).clamp(1, 20))
            .fetch_one(&mut *transaction)
            .await?;
            if attempted_artifact != event.artifact_id {
                transaction.commit().await?;
                return Ok(Claim::Discard);
            }
        }
        transaction.commit().await?;

        let permissions: Value = row.try_get(7)?;
        let permissions = permissions
            .as_array()
            .and_then(|values| {
                values
                    .iter()
                    .map(|value| value.as_str().map(str::to_owned))
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| sqlx::Error::Protocol("release permissions are invalid".to_owned()))?;
        let kind = match row.try_get::<String, _>(9)?.as_str() {
            "art" => PackageKind::Art,
            "capability" => PackageKind::Capability,
            "app_update" => PackageKind::AppUpdate,
            _ => return Err(sqlx::Error::Protocol("package kind is invalid".to_owned())),
        };
        Ok(Claim::Ready(ArtifactContext {
            artifact_id: event.artifact_id,
            release_id: row.try_get(5)?,
            package_id: row.try_get(8)?,
            publisher_id: row.try_get(11)?,
            object_key,
            size_bytes: u64::try_from(row.try_get::<i64, _>(2)?)
                .map_err(|_| sqlx::Error::Protocol("artifact size is invalid".to_owned()))?,
            media_type: row.try_get(3)?,
            kind,
            package_slug: row.try_get(10)?,
            publisher_slug: row.try_get(12)?,
            version: row.try_get(6)?,
            permissions,
        }))
    }

    pub async fn trusted_key(
        &self,
        publisher_id: Uuid,
        key_id: &str,
    ) -> Result<Option<[u8; 32]>, sqlx::Error> {
        let key = sqlx::query_scalar::<_, Vec<u8>>(
            "SELECT k.public_key FROM publisher_signing_keys k \
             JOIN publishers p ON p.id = k.publisher_id \
             WHERE k.publisher_id = $1 AND k.key_id = $2 \
             AND k.status = 'active' AND p.status = 'active'",
        )
        .bind(publisher_id)
        .bind(key_id)
        .fetch_optional(&self.pool)
        .await?;
        key.map(|bytes| {
            bytes
                .try_into()
                .map_err(|_| sqlx::Error::Protocol("publisher key length is invalid".to_owned()))
        })
        .transpose()
    }

    pub async fn record_retry(
        &self,
        context: &ArtifactContext,
        event_id: Uuid,
        delivery: i64,
        failure_code: &str,
    ) -> Result<(), sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query(
            "UPDATE artifacts SET status='uploaded', last_scan_error=$2, scanner_version=$3, \
                    rule_version=$4 WHERE id=$1 AND status='scanning'",
        )
        .bind(context.artifact_id)
        .bind(failure_code)
        .bind(SCANNER_VERSION)
        .bind(RULE_VERSION)
        .execute(&mut *transaction)
        .await?;
        sqlx::query(
            "UPDATE artifact_scan_attempts SET result='retry', failure_code=$3 \
             WHERE event_id=$1 AND delivery_count=$2",
        )
        .bind(event_id)
        .bind(i32::try_from(delivery).unwrap_or(20).clamp(1, 20))
        .bind(failure_code)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await
    }
}
