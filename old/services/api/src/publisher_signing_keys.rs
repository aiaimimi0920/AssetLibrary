use assetlibrary_contracts::{
    PublisherSigningKey, RegisterSigningKeyRequest, RevokeSigningKeyRequest, SigningKeyAlgorithm,
    SigningKeyStatus,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef,
    publisher::{PageFilter, PostgresPublisherRepository, SigningKeyCursor},
    publisher_mutations::{audit, emit},
    workflow::{WorkflowError, idempotency},
};

type KeyRow = (
    Uuid,
    String,
    Vec<u8>,
    String,
    OffsetDateTime,
    Option<OffsetDateTime>,
);

pub async fn list(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    filter: &PageFilter<SigningKeyCursor>,
) -> Result<(Vec<PublisherSigningKey>, Option<SigningKeyCursor>), WorkflowError> {
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    authorize(&mut tx, principal, publisher_id, false).await?;
    let mut rows = sqlx::query_as::<_, KeyRow>(
        "SELECT publisher_id,key_id,public_key,status,created_at,revoked_at \
         FROM publisher_signing_keys WHERE publisher_id=$1 AND \
         ($2::timestamptz IS NULL OR created_at<$2 OR (created_at=$2 AND key_id>$3)) \
         ORDER BY created_at DESC,key_id LIMIT $4",
    )
    .bind(publisher_id)
    .bind(filter.cursor.as_ref().map(|cursor| cursor.created_at))
    .bind(filter.cursor.as_ref().map(|cursor| cursor.key_id.as_str()))
    .bind(i64::from(filter.limit) + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    let has_more = rows.len() > usize::from(filter.limit);
    rows.truncate(usize::from(filter.limit));
    let next = has_more.then(|| {
        let row = rows.last().expect("non-empty bounded key page");
        SigningKeyCursor {
            created_at: row.4,
            key_id: row.1.clone(),
        }
    });
    let items = rows
        .into_iter()
        .map(key_contract)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, next))
}

pub async fn register(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    key: &str,
    request_id: &str,
    request: &RegisterSigningKeyRequest,
) -> Result<PublisherSigningKey, WorkflowError> {
    let operation = "publisher.signing_key.register";
    let digest = idempotency::request_digest(operation, &publisher_id.to_string(), request);
    let public_key = request.public_key().ok_or(WorkflowError::InvalidState)?;
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    authorize(&mut tx, principal, publisher_id, true).await?;
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    let duplicate = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM publisher_signing_keys WHERE publisher_id=$1 AND public_key=$2)",
    )
    .bind(publisher_id)
    .bind(public_key.as_slice())
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    if duplicate {
        return Err(WorkflowError::InvalidState);
    }
    let row = sqlx::query_as::<_, KeyRow>(
        "INSERT INTO publisher_signing_keys (publisher_id,key_id,public_key,status) \
         VALUES ($1,$2,$3,'active') RETURNING publisher_id,key_id,public_key,status,created_at,revoked_at",
    )
    .bind(publisher_id)
    .bind(&request.key_id)
    .bind(public_key.as_slice())
    .fetch_one(&mut *tx)
    .await
    .map_err(map_insert_error)?;
    let signing_key = key_contract(row)?;
    audit(
        &mut tx,
        principal,
        "signing_key.registered",
        "signing_key",
        publisher_id,
        request_id,
        serde_json::json!({"key_id": signing_key.key_id, "fingerprint": signing_key.fingerprint}),
    )
    .await?;
    emit(
        &mut tx,
        principal,
        "assetlibrary.publisher.signing_key.v1",
        "publisher",
        publisher_id,
        serde_json::json!({
            "publisher_id": publisher_id,
            "key_id": signing_key.key_id,
            "algorithm": signing_key.algorithm,
            "fingerprint": signing_key.fingerprint,
            "action": "registered"
        }),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &signing_key).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(signing_key)
}

#[allow(clippy::too_many_arguments)]
pub async fn revoke(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    key_id: &str,
    key: &str,
    request_id: &str,
    request: &RevokeSigningKeyRequest,
) -> Result<PublisherSigningKey, WorkflowError> {
    let operation = "publisher.signing_key.revoke";
    let target = format!("{publisher_id}:{key_id}");
    let digest = idempotency::request_digest(operation, &target, request);
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    authorize(&mut tx, principal, publisher_id, true).await?;
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    let current = sqlx::query_as::<_, KeyRow>(
        "SELECT publisher_id,key_id,public_key,status,created_at,revoked_at \
         FROM publisher_signing_keys WHERE publisher_id=$1 AND key_id=$2 FOR UPDATE",
    )
    .bind(publisher_id)
    .bind(key_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    if current.3 == "revoked" {
        let signing_key = key_contract(current)?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &signing_key).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        return Ok(signing_key);
    }
    let row = sqlx::query_as::<_, KeyRow>(
        "UPDATE publisher_signing_keys SET status='revoked',revoked_at=now() \
         WHERE publisher_id=$1 AND key_id=$2 AND status='active' \
         RETURNING publisher_id,key_id,public_key,status,created_at,revoked_at",
    )
    .bind(publisher_id)
    .bind(key_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::InvalidState)?;
    let signing_key = key_contract(row)?;
    audit(
        &mut tx,
        principal,
        "signing_key.revoked",
        "signing_key",
        publisher_id,
        request_id,
        serde_json::json!({
            "key_id": signing_key.key_id,
            "fingerprint": signing_key.fingerprint,
            "reason": request.reason
        }),
    )
    .await?;
    emit(
        &mut tx,
        principal,
        "assetlibrary.publisher.signing_key.v1",
        "publisher",
        publisher_id,
        serde_json::json!({
            "publisher_id": publisher_id,
            "key_id": signing_key.key_id,
            "algorithm": signing_key.algorithm,
            "fingerprint": signing_key.fingerprint,
            "action": "revoked",
            "reason": request.reason
        }),
    )
    .await?;
    crate::publisher_key_invalidation::emit_revocation(&mut tx, principal, publisher_id, key_id)
        .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &signing_key).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(signing_key)
}

async fn authorize(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    management: bool,
) -> Result<(), WorkflowError> {
    let query = if management {
        "SELECT pub.status,pm.role FROM publishers pub JOIN publisher_members pm ON pm.publisher_id=pub.id \
         AND pm.principal_issuer=$2 AND pm.principal_subject=$3 AND pm.status='active' \
         WHERE pub.id=$1 FOR UPDATE OF pub,pm"
    } else {
        "SELECT pub.status,pm.role FROM publishers pub JOIN publisher_members pm ON pm.publisher_id=pub.id \
         AND pm.principal_issuer=$2 AND pm.principal_subject=$3 AND pm.status='active' \
         WHERE pub.id=$1"
    };
    let state = sqlx::query_as::<_, (String, String)>(query)
        .bind(publisher_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .fetch_optional(&mut **tx)
        .await
        .map_err(|_| WorkflowError::Database)?
        .ok_or(WorkflowError::Forbidden)?;
    if management && state.0 != "active" {
        return Err(WorkflowError::InvalidState);
    }
    if management && !matches!(state.1.as_str(), "owner" | "maintainer") {
        return Err(WorkflowError::Forbidden);
    }
    Ok(())
}

fn key_contract(row: KeyRow) -> Result<PublisherSigningKey, WorkflowError> {
    let status = match row.3.as_str() {
        "active" => SigningKeyStatus::Active,
        "revoked" => SigningKeyStatus::Revoked,
        _ => return Err(WorkflowError::Database),
    };
    let signing_key = PublisherSigningKey {
        publisher_id: row.0,
        key_id: row.1,
        algorithm: SigningKeyAlgorithm::Ed25519,
        public_key_base64: STANDARD.encode(&row.2),
        fingerprint: format!("sha256:{}", hex::encode(Sha256::digest(&row.2))),
        status,
        created_at: row
            .4
            .format(&Rfc3339)
            .map_err(|_| WorkflowError::Database)?,
        revoked_at: row
            .5
            .map(|value| value.format(&Rfc3339))
            .transpose()
            .map_err(|_| WorkflowError::Database)?,
    };
    signing_key
        .validate()
        .then_some(signing_key)
        .ok_or(WorkflowError::Database)
}

fn map_insert_error(error: sqlx::Error) -> WorkflowError {
    if error
        .as_database_error()
        .and_then(|database| database.code())
        .is_some_and(|code| code == "23505")
    {
        WorkflowError::InvalidState
    } else {
        tracing::error!(?error, "signing key mutation failed");
        WorkflowError::Database
    }
}
