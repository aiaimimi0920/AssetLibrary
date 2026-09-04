use assetlibrary_contracts::{ArtifactStatus, CreateUploadSessionRequest, UploadSession};
use async_trait::async_trait;
use serde_json::Value;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::artifact::request_digest;
use crate::identity::PrincipalRef;

mod development;
pub use development::DevelopmentUploadRepository;

#[derive(Debug)]
pub enum UploadRepositoryError {
    Forbidden,
    IdempotencyConflict,
    Database,
}

pub struct UploadReservation {
    pub session: UploadSession,
    pub storage_upload_id: Option<String>,
    pub expected_size_bytes: u64,
}

#[async_trait]
pub trait UploadRepository: Send + Sync {
    async fn create_session(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        idempotency_key: &str,
        request_id: &str,
        request: &CreateUploadSessionRequest,
    ) -> Result<UploadReservation, UploadRepositoryError>;

    async fn bind_storage_upload(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
        storage_upload_id: &str,
    ) -> Result<String, UploadRepositoryError>;

    async fn get_session(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
    ) -> Result<UploadReservation, UploadRepositoryError>;

    async fn mark_uploaded(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
        request_id: &str,
    ) -> Result<UploadSession, UploadRepositoryError>;
}

pub struct PostgresUploadRepository {
    pool: PgPool,
}

impl PostgresUploadRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

type UploadRow = (Uuid, Uuid, Uuid, String, i64, i32, i64, String, Value);

fn into_session(row: UploadRow) -> Result<UploadSession, UploadRepositoryError> {
    let status = match row.7.as_str() {
        "pending_upload" => ArtifactStatus::PendingUpload,
        "uploaded" => ArtifactStatus::Uploaded,
        "scanning" => ArtifactStatus::Scanning,
        "verified" => ArtifactStatus::Verified,
        "quarantined" => ArtifactStatus::Quarantined,
        "deleted" => ArtifactStatus::Deleted,
        _ => return Err(UploadRepositoryError::Database),
    };
    let expected_digest =
        serde_json::from_value(row.8).map_err(|_| UploadRepositoryError::Database)?;
    Ok(UploadSession {
        id: row.0,
        release_id: row.1,
        artifact_id: row.2,
        object_key: row.3,
        part_size_bytes: u64::try_from(row.4).map_err(|_| UploadRepositoryError::Database)?,
        max_parts: u16::try_from(row.5).map_err(|_| UploadRepositoryError::Database)?,
        expires_at_epoch_seconds: u64::try_from(row.6)
            .map_err(|_| UploadRepositoryError::Database)?,
        status,
        expected_digest,
    })
}

async fn find_existing(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    key: &str,
) -> Result<Option<(UploadReservation, Vec<u8>)>, UploadRepositoryError> {
    let row = sqlx::query_as::<
        _,
        (
            Uuid,
            Uuid,
            Uuid,
            String,
            i64,
            i32,
            i64,
            String,
            Value,
            Vec<u8>,
            Option<String>,
            i64,
        ),
    >(
        "SELECT us.id, us.release_id, us.artifact_id, us.object_key, us.part_size_bytes, us.max_parts, \
         EXTRACT(EPOCH FROM us.expires_at)::bigint, us.status, us.expected_digest, us.request_digest, \
         us.storage_upload_id, a.size_bytes FROM upload_sessions us JOIN artifacts a ON a.id=us.artifact_id \
         WHERE us.principal_issuer = $1 AND us.principal_subject = $2 AND us.idempotency_key = $3",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| UploadRepositoryError::Database)?;
    row.map(|value| {
        let digest = value.9;
        let session = into_session((
            value.0, value.1, value.2, value.3, value.4, value.5, value.6, value.7, value.8,
        ))?;
        Ok((
            UploadReservation {
                session,
                storage_upload_id: value.10,
                expected_size_bytes: u64::try_from(value.11)
                    .map_err(|_| UploadRepositoryError::Database)?,
            },
            digest,
        ))
    })
    .transpose()
}

#[async_trait]
impl UploadRepository for PostgresUploadRepository {
    async fn create_session(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        idempotency_key: &str,
        request_id: &str,
        request: &CreateUploadSessionRequest,
    ) -> Result<UploadReservation, UploadRepositoryError> {
        let digest = request_digest(release_id, request);
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| UploadRepositoryError::Database)?;
        let lock_key = format!(
            "{}:{}:{idempotency_key}",
            principal.issuer, principal.subject
        );
        sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
            .bind(lock_key)
            .execute(&mut *transaction)
            .await
            .map_err(|_| UploadRepositoryError::Database)?;
        let authorization = sqlx::query_as::<_, (String, String, String, String)>(
            "SELECT r.status,pub.status,pm.status,pm.role FROM releases r JOIN packages p ON p.id = r.package_id \
             JOIN publishers pub ON pub.id = p.publisher_id JOIN publisher_members pm ON pm.publisher_id = pub.id \
             WHERE r.id = $1 AND pm.principal_issuer = $2 AND pm.principal_subject = $3 \
             FOR SHARE OF r,pub,pm",
        )
        .bind(release_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| UploadRepositoryError::Database)?
        .ok_or(UploadRepositoryError::Forbidden)?;
        if authorization.1 != "active"
            || authorization.2 != "active"
            || !matches!(
                authorization.3.as_str(),
                "owner" | "maintainer" | "release_manager"
            )
        {
            return Err(UploadRepositoryError::Forbidden);
        }
        if let Some((reservation, stored)) =
            find_existing(&mut transaction, principal, idempotency_key).await?
        {
            return if stored == digest {
                Ok(reservation)
            } else {
                Err(UploadRepositoryError::IdempotencyConflict)
            };
        }
        if !matches!(authorization.0.as_str(), "draft" | "uploading" | "rejected") {
            return Err(UploadRepositoryError::Forbidden);
        }
        let session_id = Uuid::new_v4();
        let artifact_id = Uuid::new_v4();
        let object_key = format!(
            "quarantine/{release_id}/{artifact_id}/{}",
            request.file_name
        );
        sqlx::query("INSERT INTO artifacts (id, release_id, object_key, size_bytes, media_type) VALUES ($1, $2, $3, $4, $5)")
            .bind(artifact_id).bind(release_id).bind(&object_key)
            .bind(i64::try_from(request.size_bytes).map_err(|_| UploadRepositoryError::Database)?)
            .bind(&request.media_type).execute(&mut *transaction).await.map_err(|_| UploadRepositoryError::Database)?;
        let expected = serde_json::to_value(&request.expected_digest)
            .map_err(|_| UploadRepositoryError::Database)?;
        let row = sqlx::query_as::<_, UploadRow>(
            "INSERT INTO upload_sessions (id, release_id, artifact_id, principal_issuer, principal_subject, \
             idempotency_key, request_digest, object_key, part_size_bytes, max_parts, expires_at, expected_digest) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,now() + interval '1 hour',$11) \
             RETURNING id, release_id, artifact_id, object_key, part_size_bytes, max_parts, \
             EXTRACT(EPOCH FROM expires_at)::bigint, status, expected_digest",
        )
        .bind(session_id).bind(release_id).bind(artifact_id).bind(&principal.issuer).bind(&principal.subject)
        .bind(idempotency_key).bind(digest.as_slice()).bind(object_key)
        .bind(i64::try_from(request.part_size_bytes).map_err(|_| UploadRepositoryError::Database)?)
        .bind(i32::from(request.part_count)).bind(expected).fetch_one(&mut *transaction).await
        .map_err(|_| UploadRepositoryError::Database)?;
        let session = into_session(row)?;
        sqlx::query("INSERT INTO audit_events (actor_issuer, actor_subject, action, resource_type, resource_id, correlation_id, details) VALUES ($1,$2,'upload_session.created','artifact',$3,$4,$5)")
            .bind(&principal.issuer).bind(&principal.subject).bind(artifact_id).bind(request_id)
            .bind(serde_json::json!({"release_id": release_id, "session_id": session_id}))
            .execute(&mut *transaction).await.map_err(|_| UploadRepositoryError::Database)?;
        transaction
            .commit()
            .await
            .map_err(|_| UploadRepositoryError::Database)?;
        Ok(UploadReservation {
            session,
            storage_upload_id: None,
            expected_size_bytes: request.size_bytes,
        })
    }

    async fn bind_storage_upload(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
        storage_upload_id: &str,
    ) -> Result<String, UploadRepositoryError> {
        sqlx::query_scalar::<_, String>(
            "UPDATE upload_sessions SET storage_upload_id = COALESCE(storage_upload_id, $1) \
             WHERE id = $2 AND principal_issuer = $3 AND principal_subject = $4 \
             RETURNING storage_upload_id",
        )
        .bind(storage_upload_id)
        .bind(session_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| UploadRepositoryError::Database)?
        .ok_or(UploadRepositoryError::Forbidden)
    }

    async fn get_session(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
    ) -> Result<UploadReservation, UploadRepositoryError> {
        let row = sqlx::query_as::<
            _,
            (
                Uuid,
                Uuid,
                Uuid,
                String,
                i64,
                i32,
                i64,
                String,
                Value,
                Option<String>,
                i64,
            ),
        >(
            "SELECT us.id, us.release_id, us.artifact_id, us.object_key, us.part_size_bytes, us.max_parts, \
             EXTRACT(EPOCH FROM us.expires_at)::bigint, us.status, us.expected_digest, us.storage_upload_id, \
             a.size_bytes FROM upload_sessions us JOIN artifacts a ON a.id=us.artifact_id \
             JOIN releases r ON r.id=us.release_id JOIN packages p ON p.id=r.package_id \
             JOIN publishers pub ON pub.id=p.publisher_id JOIN publisher_members pm ON pm.publisher_id=pub.id \
             WHERE us.id = $1 AND us.principal_issuer = $2 AND us.principal_subject = $3 \
             AND pm.principal_issuer = $2 AND pm.principal_subject = $3 AND pub.status='active' \
             AND pm.status='active' AND pm.role IN ('owner','maintainer','release_manager') \
             AND us.expires_at > now() AND us.status IN ('pending_upload', 'uploaded') \
             AND (us.status='uploaded' OR r.status IN ('draft','uploading','rejected'))",
        )
        .bind(session_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| UploadRepositoryError::Database)?
        .ok_or(UploadRepositoryError::Forbidden)?;
        Ok(UploadReservation {
            storage_upload_id: row.9,
            expected_size_bytes: u64::try_from(row.10)
                .map_err(|_| UploadRepositoryError::Database)?,
            session: into_session((
                row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
            ))?,
        })
    }

    async fn mark_uploaded(
        &self,
        principal: &PrincipalRef,
        session_id: Uuid,
        request_id: &str,
    ) -> Result<UploadSession, UploadRepositoryError> {
        let mut transaction = self
            .pool
            .begin()
            .await
            .map_err(|_| UploadRepositoryError::Database)?;
        let row = sqlx::query_as::<_, UploadRow>(
            "SELECT us.id, us.release_id, us.artifact_id, us.object_key, us.part_size_bytes, us.max_parts, \
             EXTRACT(EPOCH FROM us.expires_at)::bigint, us.status, us.expected_digest FROM upload_sessions us \
             JOIN releases r ON r.id=us.release_id JOIN packages p ON p.id=r.package_id \
             JOIN publishers pub ON pub.id=p.publisher_id JOIN publisher_members pm ON pm.publisher_id=pub.id \
             WHERE us.id = $1 AND us.principal_issuer = $2 AND us.principal_subject = $3 \
             AND pm.principal_issuer = $2 AND pm.principal_subject = $3 AND pub.status='active' \
             AND pm.status='active' AND pm.role IN ('owner','maintainer','release_manager') \
             AND us.expires_at > now() AND us.status IN ('pending_upload', 'uploaded') \
             AND (us.status='uploaded' OR r.status IN ('draft','uploading','rejected')) \
             FOR UPDATE OF us,r,pub,pm",
        )
        .bind(session_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .fetch_optional(&mut *transaction)
        .await
        .map_err(|_| UploadRepositoryError::Database)?
        .ok_or(UploadRepositoryError::Forbidden)?;
        let mut session = into_session(row)?;
        if session.status == ArtifactStatus::Uploaded {
            transaction
                .commit()
                .await
                .map_err(|_| UploadRepositoryError::Database)?;
            return Ok(session);
        }
        sqlx::query("UPDATE upload_sessions SET status = 'uploaded' WHERE id = $1")
            .bind(session_id)
            .execute(&mut *transaction)
            .await
            .map_err(|_| UploadRepositoryError::Database)?;
        sqlx::query(
            "UPDATE artifacts SET status = 'uploaded' WHERE id = $1 AND status = 'pending_upload'",
        )
        .bind(session.artifact_id)
        .execute(&mut *transaction)
        .await
        .map_err(|_| UploadRepositoryError::Database)?;
        let event_id = Uuid::new_v4();
        let inserted = sqlx::query(
            "INSERT INTO outbox_events \
             (id,subject,schema_version,aggregate_type,aggregate_id,payload) \
             SELECT $1,'assetlibrary.artifact.verification_requested.v1','1.0','artifact',$2, \
             jsonb_build_object('event_id',$1,'occurred_at',now(),'schema_version','1.0', \
                'actor',jsonb_build_object('type','principal','issuer',$6,'subject',$7), \
                'package_id',r.package_id,'release_id',$3,'artifact_id',$2, \
                'object_key',$4,'digest',$5) FROM releases r WHERE r.id=$3",
        )
        .bind(event_id)
        .bind(session.artifact_id)
        .bind(session.release_id)
        .bind(&session.object_key)
        .bind(&session.expected_digest.value)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .execute(&mut *transaction)
        .await
        .map_err(|_| UploadRepositoryError::Database)?;
        if inserted.rows_affected() != 1 {
            return Err(UploadRepositoryError::Database);
        }
        sqlx::query("INSERT INTO audit_events (actor_issuer, actor_subject, action, resource_type, resource_id, correlation_id, details) VALUES ($1,$2,'upload_session.completed','artifact',$3,$4,$5)")
            .bind(&principal.issuer).bind(&principal.subject).bind(session.artifact_id).bind(request_id)
            .bind(serde_json::json!({"release_id": session.release_id, "session_id": session_id, "event_id": event_id}))
            .execute(&mut *transaction).await.map_err(|_| UploadRepositoryError::Database)?;
        transaction
            .commit()
            .await
            .map_err(|_| UploadRepositoryError::Database)?;
        session.status = ArtifactStatus::Uploaded;
        Ok(session)
    }
}
