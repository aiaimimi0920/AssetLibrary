use assetlibrary_contracts::SubmissionView;
use serde_json::json;
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    PostgresReviewRepository, WorkflowError,
    authorization::require_store_role,
    idempotency,
    submission::{load_view, record_transition},
};

pub async fn publish(
    repository: &PostgresReviewRepository,
    principal: &PrincipalRef,
    submission_id: Uuid,
    key: &str,
    request_id: &str,
) -> Result<SubmissionView, WorkflowError> {
    let operation = "submission.publish";
    let digest = idempotency::request_digest(operation, &submission_id.to_string(), &());
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    require_store_role(&mut tx, principal, &["operator"]).await?;
    let facts = sqlx::query_as::<_, (Uuid, Uuid, Uuid, Uuid, i32, i16, String, String, String, String, String, Option<Vec<u8>>, Option<String>, Option<String>)>(
        "SELECT s.release_id,r.package_id,p.publisher_id,s.artifact_id,s.revision,s.required_approvals, \
         s.status,r.status,p.kind,p.status,pub.status,a.canonical_sha256,a.published_object_key,a.signature->>'keyId' \
         FROM submissions s JOIN releases r ON r.id=s.release_id JOIN packages p ON p.id=r.package_id \
         JOIN publishers pub ON pub.id=p.publisher_id JOIN artifacts a ON a.id=s.artifact_id AND a.release_id=r.id \
         WHERE s.id=$1 AND a.status='verified' FOR UPDATE OF s,r,p,pub,a",
    )
    .bind(submission_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::InvalidState)?;
    if facts.8 == "app_update" && !repository.app_updates_enabled {
        return Err(WorkflowError::FeatureDisabled);
    }
    if facts.10 != "active" || facts.9 == "suspended" {
        return Err(WorkflowError::InvalidState);
    }
    if facts.11.as_ref().is_none_or(|value| value.len() != 32)
        || facts.12.as_deref().is_none_or(str::is_empty)
        || facts.13.as_deref().is_none_or(str::is_empty)
    {
        return Err(WorkflowError::InvalidState);
    }
    let already_published = facts.7 == "published";
    if !already_published && (facts.6 != "approved" || facts.7 != "approved") {
        return Err(WorkflowError::InvalidState);
    }
    if already_published {
        let publication_matches = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM published_release_artifacts WHERE \
             release_id=$1 AND artifact_id=$2 AND approval_submission_id=$3 \
             AND source='reviewed_submission')",
        )
        .bind(facts.0)
        .bind(facts.3)
        .bind(submission_id)
        .fetch_one(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        if !publication_matches {
            return Err(WorkflowError::InvalidState);
        }
    }
    let approvals = sqlx::query_scalar::<_, i64>(
        "SELECT count(DISTINCT (v.reviewer_issuer,v.reviewer_subject)) FROM reviews v \
         JOIN store_roles sr ON sr.principal_issuer=v.reviewer_issuer AND sr.principal_subject=v.reviewer_subject \
         AND sr.role IN ('reviewer','operator') AND sr.status='active' WHERE v.submission_id=$1 \
         AND v.revision=$2 AND v.status='approved' AND NOT EXISTS (SELECT 1 FROM publisher_members pm \
         WHERE pm.publisher_id=$3 AND pm.principal_issuer=v.reviewer_issuer AND pm.principal_subject=v.reviewer_subject \
         AND pm.status='active')",
    )
    .bind(submission_id)
    .bind(facts.4)
    .bind(facts.2)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    if approvals < i64::from(facts.5) {
        return Err(WorkflowError::InvalidState);
    }
    let signing_key_id = facts.13.as_deref().ok_or(WorkflowError::InvalidState)?;
    let key_active = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM publisher_signing_keys WHERE publisher_id=$1 AND key_id=$2 \
         AND status='active' FOR SHARE",
    )
    .bind(facts.2)
    .bind(signing_key_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    if key_active.is_none() {
        return Err(WorkflowError::InvalidState);
    }
    let blocked = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM blocklist_entries WHERE status='active' AND \
         (target_type,target_ref) IN (('publisher',$1),('package',$2),('release',$3),('artifact',$4),('signing_key',$5)))",
    )
    .bind(facts.2.to_string())
    .bind(facts.1.to_string())
    .bind(facts.0.to_string())
    .bind(facts.3.to_string())
    .bind(format!("{}:{signing_key_id}", facts.2))
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    if blocked {
        return Err(WorkflowError::InvalidState);
    }
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    if !already_published {
        sqlx::query(
            "INSERT INTO published_release_artifacts \
             (release_id,artifact_id,approval_submission_id,source,published_at) \
             VALUES ($1,$2,$3,'reviewed_submission',now())",
        )
        .bind(facts.0)
        .bind(facts.3)
        .bind(submission_id)
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        sqlx::query("UPDATE releases SET status='published',published_at=now() WHERE id=$1")
            .bind(facts.0)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
        sqlx::query("UPDATE packages SET status='published' WHERE id=$1")
            .bind(facts.1)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
        emit(
            &mut tx,
            "assetlibrary.release.published.v1",
            "release",
            facts.0,
            json!({"release_id": facts.0, "package_id": facts.1, "artifact_id": facts.3}),
        )
        .await?;
        emit(
            &mut tx,
            "assetlibrary.catalog.invalidated.v1",
            "package",
            facts.1,
            json!({"package_id": facts.1, "reason": "release_published"}),
        )
        .await?;
    }
    let result = load_view(&mut tx, submission_id).await?;
    record_transition(
        &mut tx,
        principal,
        "release.published",
        submission_id,
        request_id,
        &json!({"release_id": facts.0, "package_id": facts.1, "artifact_id": facts.3}),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(result)
}

pub async fn emit(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    subject: &str,
    aggregate_type: &str,
    aggregate_id: Uuid,
    mut payload: serde_json::Value,
) -> Result<Uuid, WorkflowError> {
    let id = Uuid::new_v4();
    payload["event_id"] = json!(id);
    payload["schema_version"] = json!("1.0");
    payload["occurred_at"] = json!(
        time::OffsetDateTime::now_utc()
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|_| WorkflowError::Database)?
    );
    payload["actor"] = json!({"type": "system", "id": "assetlibrary-control-plane"});
    sqlx::query("INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload) VALUES ($1,$2,'1.0',$3,$4,$5)")
        .bind(id).bind(subject).bind(aggregate_type).bind(aggregate_id).bind(payload)
        .execute(&mut **tx).await.map_err(|_| WorkflowError::Database)?;
    Ok(id)
}
