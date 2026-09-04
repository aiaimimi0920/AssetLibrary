use serde::{Serialize, de::DeserializeOwned};
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};

use crate::identity::PrincipalRef;

use super::WorkflowError;

pub fn request_digest<T: Serialize>(operation: &str, target: &str, request: &T) -> Vec<u8> {
    let mut hasher = Sha256::new();
    hasher.update(operation.as_bytes());
    hasher.update([0]);
    hasher.update(target.as_bytes());
    hasher.update([0]);
    hasher.update(serde_json::to_vec(request).expect("serializable request contract"));
    hasher.finalize().to_vec()
}

pub async fn begin<T: DeserializeOwned>(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    operation: &str,
    key: &str,
    digest: &[u8],
) -> Result<Option<T>, WorkflowError> {
    let lock = format!(
        "{}:{}:{operation}:{key}",
        principal.issuer, principal.subject
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(lock)
        .execute(&mut **transaction)
        .await
        .map_err(|_| WorkflowError::Database)?;
    let existing = sqlx::query_as::<_, (Vec<u8>, Option<serde_json::Value>, bool)>(
        "SELECT request_digest,response_body,expires_at > now() FROM idempotency_keys \
         WHERE principal_issuer=$1 AND principal_subject=$2 AND operation=$3 AND idempotency_key=$4",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(operation)
    .bind(key)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| WorkflowError::Database)?;
    match existing {
        Some((stored, _, true)) if stored != digest => Err(WorkflowError::IdempotencyConflict),
        Some((_, Some(body), true)) => serde_json::from_value(body)
            .map(Some)
            .map_err(|_| WorkflowError::Database),
        Some((_, None, true)) => Err(WorkflowError::InvalidState),
        Some(_) => {
            sqlx::query(
                "DELETE FROM idempotency_keys WHERE principal_issuer=$1 AND principal_subject=$2 \
                 AND operation=$3 AND idempotency_key=$4",
            )
            .bind(&principal.issuer)
            .bind(&principal.subject)
            .bind(operation)
            .bind(key)
            .execute(&mut **transaction)
            .await
            .map_err(|_| WorkflowError::Database)?;
            Ok(None)
        }
        None => Ok(None),
    }
}

pub async fn finish<T: Serialize>(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    operation: &str,
    key: &str,
    digest: &[u8],
    response: &T,
) -> Result<(), WorkflowError> {
    let body = serde_json::to_value(response).map_err(|_| WorkflowError::Database)?;
    sqlx::query(
        "INSERT INTO idempotency_keys (principal_issuer,principal_subject,operation,idempotency_key, \
         request_digest,response_status,response_body,expires_at) VALUES ($1,$2,$3,$4,$5,200,$6,now()+interval '24 hours')",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(operation)
    .bind(key)
    .bind(digest)
    .bind(body)
    .execute(&mut **transaction)
    .await
    .map(|_| ())
    .map_err(|_| WorkflowError::Database)
}
