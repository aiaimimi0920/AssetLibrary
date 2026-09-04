use assetlibrary_contracts::{DecideReviewRequest, ReviewDecision, ReviewDecisionView};
use serde_json::json;
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    PostgresReviewRepository, WorkflowError,
    authorization::{is_package_member, require_store_role},
    idempotency,
    submission::{load_view, record_transition},
};

pub async fn decide(
    repository: &PostgresReviewRepository,
    principal: &PrincipalRef,
    submission_id: Uuid,
    key: &str,
    request_id: &str,
    request: &DecideReviewRequest,
) -> Result<ReviewDecisionView, WorkflowError> {
    let operation = "submission.review";
    let digest = idempotency::request_digest(operation, &submission_id.to_string(), request);
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    require_store_role(&mut tx, principal, &["reviewer", "operator"]).await?;
    let facts =
        sqlx::query_as::<_, (Uuid, Uuid, i32, String, i16, Option<String>, Option<String>)>(
            "SELECT s.release_id,r.package_id,s.revision,s.status,s.required_approvals, \
         s.submitted_by_issuer,s.submitted_by_subject \
         FROM submissions s JOIN releases r ON r.id=s.release_id WHERE s.id=$1 FOR UPDATE OF s,r",
        )
        .bind(submission_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?
        .ok_or(WorkflowError::NotFound)?;
    if facts.3 != "in_review" {
        return Err(WorkflowError::InvalidState);
    }
    let is_submitter = facts.5.as_deref() == Some(principal.issuer.as_str())
        && facts.6.as_deref() == Some(principal.subject.as_str());
    if is_submitter || is_package_member(&mut tx, principal, facts.1).await? {
        return Err(WorkflowError::Forbidden);
    }
    let review_id = Uuid::new_v4();
    let decision = match request.decision {
        ReviewDecision::Approved => "approved",
        ReviewDecision::Rejected => "rejected",
        ReviewDecision::NeedsChanges => "needs_changes",
    };
    sqlx::query(
        "INSERT INTO reviews (id,submission_id,revision,reviewer_issuer,reviewer_subject,status,reason,findings,evidence,decided_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now())",
    )
    .bind(review_id)
    .bind(submission_id)
    .bind(facts.2)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(decision)
    .bind(&request.reason)
    .bind(serde_json::to_value(&request.findings).map_err(|_| WorkflowError::Database)?)
    .bind(json!({"review_contract": "p4-v1"}))
    .execute(&mut *tx)
    .await
    .map_err(|error| {
        if error.as_database_error().is_some_and(|value| value.is_unique_violation()) {
            WorkflowError::InvalidState
        } else {
            WorkflowError::Database
        }
    })?;
    let approvals = sqlx::query_scalar::<_, i64>(
        "SELECT count(*) FROM reviews WHERE submission_id=$1 AND revision=$2 AND status='approved'",
    )
    .bind(submission_id)
    .bind(facts.2)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let next = match request.decision {
        ReviewDecision::Approved if approvals >= i64::from(facts.4) => "approved",
        ReviewDecision::Approved => "in_review",
        ReviewDecision::Rejected => "rejected",
        ReviewDecision::NeedsChanges => "changes_requested",
    };
    sqlx::query(
        "UPDATE submissions SET status=$2,decided_at=CASE WHEN $2='in_review' THEN NULL ELSE now() END WHERE id=$1",
    )
    .bind(submission_id)
    .bind(next)
    .execute(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    if next != "in_review" {
        let release_status = if next == "approved" {
            "approved"
        } else {
            "rejected"
        };
        sqlx::query("UPDATE releases SET status=$2 WHERE id=$1")
            .bind(facts.0)
            .bind(release_status)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
    }
    let submission = load_view(&mut tx, submission_id).await?;
    let result = ReviewDecisionView {
        review_id,
        submission,
    };
    record_transition(
        &mut tx,
        principal,
        "submission.reviewed",
        submission_id,
        request_id,
        &json!({
            "decision": request.decision,
            "reason": request.reason,
            "review_id": review_id,
            "revision": facts.2
        }),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(result)
}
