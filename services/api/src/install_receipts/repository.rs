use assetlibrary_contracts::{
    CreateInstallChallengeRequest, InstallChallenge, InstallReceipt, SCHEMA_VERSION_V1,
    VerifyInstallReceiptRequest, canonical_install_receipt_payload,
};
use async_trait::async_trait;
use serde_json::json;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Transaction};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef,
    workflow::{WorkflowError, idempotency, publication::emit},
};

use super::{
    InstallReceiptRepository, PostgresInstallReceiptRepository,
    access::{Proof, challenge_contract, load_download_access, load_proof, release_compatible},
};

const CHALLENGE_TTL: Duration = Duration::hours(1);

#[async_trait]
impl InstallReceiptRepository for PostgresInstallReceiptRepository {
    async fn challenge(
        &self,
        principal: &PrincipalRef,
        download_session_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateInstallChallengeRequest,
    ) -> Result<InstallChallenge, WorkflowError> {
        let operation = "install_receipt.challenge";
        let request_digest = idempotency::request_digest(
            operation,
            &format!("{download_session_id}:{}", request.receipt_id),
            request,
        );
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        let access = load_download_access(&mut tx, principal, download_session_id).await?;
        if !release_compatible(&access.compatibility, &request.host) {
            return Err(WorkflowError::InvalidState);
        }
        if let Some(replay) =
            idempotency::begin(&mut tx, principal, operation, key, &request_digest).await?
        {
            return Ok(replay);
        }
        let occupied = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM install_receipts WHERE id=$1 OR download_session_id=$2)",
        )
        .bind(request.receipt_id)
        .bind(download_session_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        if occupied {
            return Err(WorkflowError::IdempotencyConflict);
        }
        let issued_at = OffsetDateTime::now_utc();
        let expires_at = issued_at + CHALLENGE_TTL;
        let nonce = Uuid::new_v4();
        let host_digest: [u8; 32] =
            Sha256::digest(serde_json::to_vec(&request.host).map_err(|_| WorkflowError::Database)?)
                .into();
        let public_key = request
            .receipt_public_key()
            .ok_or(WorkflowError::InvalidState)?;
        sqlx::query(
            "INSERT INTO install_receipts (id,principal_issuer,principal_subject,release_id,artifact_id, \
             status,installed_digest,installed_at,download_session_id,client_instance_id,receipt_public_key, \
             challenge_nonce,challenge_expires_at,archive_digest,host_profile_digest) \
             VALUES ($1,$2,$3,$4,$5,'pending',$6,NULL,$7,$8,$9,$10,$11,$12,$13)",
        )
        .bind(request.receipt_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .bind(access.release_id)
        .bind(access.artifact_id)
        .bind(hex::decode(&access.canonical_digest).map_err(|_| WorkflowError::Database)?)
        .bind(download_session_id)
        .bind(request.client_instance_id)
        .bind(public_key.as_slice())
        .bind(nonce)
        .bind(expires_at)
        .bind(hex::decode(&access.archive_digest).map_err(|_| WorkflowError::Database)?)
        .bind(host_digest.as_slice())
        .execute(&mut *tx)
        .await
        .map_err(|error| map_unique(error))?;
        let response = challenge_contract(
            &access,
            request.receipt_id,
            request.client_instance_id,
            nonce,
            hex::encode(host_digest),
            issued_at,
            expires_at,
        )?;
        audit_challenge(&mut tx, principal, request_id, &response).await?;
        idempotency::finish(
            &mut tx,
            principal,
            operation,
            key,
            &request_digest,
            &response,
        )
        .await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(response)
    }

    async fn verify(
        &self,
        principal: &PrincipalRef,
        receipt_id: Uuid,
        key: &str,
        request_id: &str,
        request: &VerifyInstallReceiptRequest,
    ) -> Result<InstallReceipt, WorkflowError> {
        let operation = "install_receipt.verify";
        let request_digest =
            idempotency::request_digest(operation, &receipt_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        let proof = load_proof(&mut tx, principal, receipt_id).await?;
        if let Some(replay) =
            idempotency::begin(&mut tx, principal, operation, key, &request_digest).await?
        {
            return Ok(replay);
        }
        if proof.status != "pending" {
            return Err(WorkflowError::InvalidState);
        }
        let now = OffsetDateTime::now_utc();
        let installed_at = OffsetDateTime::from_unix_timestamp(request.installed_at_epoch_seconds)
            .map_err(|_| WorkflowError::InvalidState)?;
        if proof.expires_at < now
            || installed_at < proof.issued_at - Duration::minutes(5)
            || installed_at > now + Duration::minutes(1)
            || installed_at > proof.expires_at + Duration::minutes(1)
        {
            return Err(WorkflowError::InvalidState);
        }
        let challenge = challenge_contract(
            &proof.access,
            proof.receipt_id,
            proof.client_instance_id,
            proof.nonce,
            proof.host_profile_digest.clone(),
            proof.issued_at,
            proof.expires_at,
        )?;
        let signature = request.signature().ok_or(WorkflowError::Forbidden)?;
        assetlibrary_supply_chain::verify_ed25519_message(
            &canonical_install_receipt_payload(&challenge, request.installed_at_epoch_seconds),
            &proof.receipt_public_key,
            &signature,
        )
        .map_err(|_| WorkflowError::Forbidden)?;
        let (installed_at, verified_at) = persist_verified(
            &mut tx,
            principal,
            request_id,
            &proof,
            installed_at,
            &signature,
        )
        .await?;
        let response = receipt_contract(&proof, installed_at, verified_at)?;
        idempotency::finish(
            &mut tx,
            principal,
            operation,
            key,
            &request_digest,
            &response,
        )
        .await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(response)
    }
}

async fn persist_verified(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    request_id: &str,
    proof: &Proof,
    installed_at: OffsetDateTime,
    signature: &[u8; 64],
) -> Result<(OffsetDateTime, OffsetDateTime), WorkflowError> {
    let timestamps = sqlx::query_as::<_, (OffsetDateTime, OffsetDateTime)>(
        "UPDATE install_receipts SET status='verified',installed_at=$2,signature=$3,verified_at=now() \
         WHERE id=$1 AND status='pending' RETURNING installed_at,verified_at",
    )
    .bind(proof.receipt_id)
    .bind(installed_at)
    .bind(signature.as_slice())
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::InvalidState)?;
    sqlx::query(
        "INSERT INTO library_entries (principal_issuer,principal_subject,package_id,status,favorite, \
         installed_release_id,installed_artifact_id) VALUES ($1,$2,$3,'listed',false,$4,$5) \
         ON CONFLICT (principal_issuer,principal_subject,package_id) DO UPDATE SET status='listed', \
         installed_release_id=EXCLUDED.installed_release_id,installed_artifact_id=EXCLUDED.installed_artifact_id, \
         updated_at=now()",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(proof.access.package_id)
    .bind(proof.access.release_id)
    .bind(proof.access.artifact_id)
    .execute(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    sqlx::query(
        "INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id, \
         correlation_id,details) VALUES ($1,$2,'install_receipt.verified','install_receipt',$3,$4,$5)",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(proof.receipt_id)
    .bind(request_id)
    .bind(json!({"release_id": proof.access.release_id, "artifact_id": proof.access.artifact_id}))
    .execute(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    emit(
        tx,
        "assetlibrary.install_receipt.verified.v1",
        "install_receipt",
        proof.receipt_id,
        json!({
            "receipt_id": proof.receipt_id,
            "package_id": proof.access.package_id,
            "release_id": proof.access.release_id,
            "artifact_id": proof.access.artifact_id,
            "digest": format!("sha256:{}", proof.access.canonical_digest),
        }),
    )
    .await?;
    Ok(timestamps)
}

async fn audit_challenge(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    request_id: &str,
    challenge: &InstallChallenge,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id, \
         correlation_id,details) VALUES ($1,$2,'install_receipt.challenge_created','install_receipt',$3,$4,$5)",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(challenge.receipt_id)
    .bind(request_id)
    .bind(json!({
        "download_session_id": challenge.download_session_id,
        "release_id": challenge.artifact.release_id,
        "artifact_id": challenge.artifact.artifact_id,
    }))
    .execute(&mut **tx)
    .await
    .map(|_| ())
    .map_err(|_| WorkflowError::Database)
}

fn receipt_contract(
    proof: &Proof,
    installed_at: OffsetDateTime,
    verified_at: OffsetDateTime,
) -> Result<InstallReceipt, WorkflowError> {
    Ok(InstallReceipt {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        receipt_id: proof.receipt_id,
        release_id: proof.access.release_id,
        artifact_id: proof.access.artifact_id,
        digest: proof.access.canonical_digest.clone(),
        status: "verified".to_owned(),
        installed_at: installed_at
            .format(&Rfc3339)
            .map_err(|_| WorkflowError::Database)?,
        verified_at: verified_at
            .format(&Rfc3339)
            .map_err(|_| WorkflowError::Database)?,
    })
}

fn map_unique(error: sqlx::Error) -> WorkflowError {
    if error
        .as_database_error()
        .and_then(|error| error.code())
        .as_deref()
        == Some("23505")
    {
        WorkflowError::IdempotencyConflict
    } else {
        WorkflowError::Database
    }
}
