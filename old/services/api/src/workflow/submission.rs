use assetlibrary_contracts::{
    CreateSubmissionRequest, SubmissionStatus, SubmissionView, WithdrawSubmissionRequest,
};
use async_trait::async_trait;
use serde_json::json;
use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    PostgresReviewRepository, ReviewRepository, WorkflowError, authorization::is_package_member,
    idempotency,
};

type SubmissionRow = (Uuid, Uuid, Uuid, i32, String, i16, i64, String, String);

fn status(value: &str) -> Result<SubmissionStatus, WorkflowError> {
    match value {
        "in_review" => Ok(SubmissionStatus::InReview),
        "changes_requested" => Ok(SubmissionStatus::ChangesRequested),
        "approved" => Ok(SubmissionStatus::Approved),
        "rejected" => Ok(SubmissionStatus::Rejected),
        "withdrawn" => Ok(SubmissionStatus::Withdrawn),
        _ => Err(WorkflowError::Database),
    }
}

pub(super) fn view(row: SubmissionRow) -> Result<SubmissionView, WorkflowError> {
    Ok(SubmissionView {
        id: row.0,
        release_id: row.1,
        artifact_id: row.2,
        revision: u32::try_from(row.3).map_err(|_| WorkflowError::Database)?,
        status: status(&row.4)?,
        required_approvals: u8::try_from(row.5).map_err(|_| WorkflowError::Database)?,
        approval_count: u8::try_from(row.6).map_err(|_| WorkflowError::Database)?,
        scanner_version: row.7,
        rule_version: row.8,
    })
}

pub async fn load_view(
    transaction: &mut Transaction<'_, Postgres>,
    submission_id: Uuid,
) -> Result<SubmissionView, WorkflowError> {
    let row = sqlx::query_as::<_, SubmissionRow>(
        "SELECT s.id,s.release_id,s.artifact_id,s.revision,s.status,s.required_approvals, \
         count(r.id) FILTER (WHERE r.status='approved' AND r.revision=s.revision), \
         s.scanner_version,s.rule_version FROM submissions s LEFT JOIN reviews r ON r.submission_id=s.id \
         WHERE s.id=$1 AND s.artifact_id IS NOT NULL AND s.scanner_version IS NOT NULL \
         AND s.rule_version IS NOT NULL GROUP BY s.id",
    )
    .bind(submission_id)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    view(row)
}

#[async_trait]
impl ReviewRepository for PostgresReviewRepository {
    async fn submit(
        &self,
        principal: &PrincipalRef,
        release_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateSubmissionRequest,
    ) -> Result<SubmissionView, WorkflowError> {
        let operation = "submission.submit";
        let digest = idempotency::request_digest(operation, &release_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        let facts = sqlx::query_as::<_, (Uuid, String, String, String, String, Option<String>, Option<String>, Option<Vec<u8>>, Option<String>)>(
            "SELECT r.package_id,p.kind,r.status,p.status,pub.status,a.scanner_version,a.rule_version, \
             a.canonical_sha256,a.published_object_key FROM releases r JOIN packages p ON p.id=r.package_id \
             JOIN publishers pub ON pub.id=p.publisher_id JOIN artifacts a ON a.release_id=r.id \
             WHERE r.id=$1 AND a.id=$2 AND a.status='verified' FOR UPDATE OF r,p,pub,a",
        )
        .bind(release_id)
        .bind(request.artifact_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?
        .ok_or(WorkflowError::InvalidState)?;
        if !is_package_member(&mut tx, principal, facts.0).await? {
            return Err(WorkflowError::Forbidden);
        }
        if let Some(replay) =
            idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(replay);
        }
        if facts.2 == "published" || facts.3 == "suspended" || facts.4 != "active" {
            return Err(WorkflowError::InvalidState);
        }
        if facts.1 == "app_update" && !self.app_updates_enabled {
            return Err(WorkflowError::FeatureDisabled);
        }
        let scanner_version = facts
            .5
            .filter(|value| !value.is_empty())
            .ok_or(WorkflowError::InvalidState)?;
        let rule_version = facts
            .6
            .filter(|value| !value.is_empty())
            .ok_or(WorkflowError::InvalidState)?;
        let canonical_sha256 = facts
            .7
            .filter(|value| value.len() == 32)
            .ok_or(WorkflowError::InvalidState)?;
        if facts.8.as_deref().is_none_or(str::is_empty) {
            return Err(WorkflowError::InvalidState);
        }
        let blocked = sqlx::query_scalar::<_, bool>(
            "SELECT EXISTS(SELECT 1 FROM blocklist_entries b WHERE b.status='active' AND \
             (b.target_type,b.target_ref) IN (('publisher',(SELECT publisher_id::text FROM packages WHERE id=$5)), \
             ('package',$1),('release',$2),('artifact',$3),('signing_key',(SELECT p.publisher_id::text || ':' || (a.signature->>'keyId') \
             FROM packages p CROSS JOIN artifacts a WHERE p.id=$5 AND a.id=$4)))) OR NOT EXISTS \
             (SELECT 1 FROM packages p JOIN publisher_signing_keys k ON k.publisher_id=p.publisher_id \
             JOIN artifacts a ON a.id=$4 WHERE p.id=$5 AND k.key_id=a.signature->>'keyId' AND k.status='active')",
        )
        .bind(facts.0.to_string())
        .bind(release_id.to_string())
        .bind(request.artifact_id.to_string())
        .bind(request.artifact_id)
        .bind(facts.0)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| {
            tracing::error!(?error, "submission policy query failed");
            WorkflowError::Database
        })?;
        if blocked {
            return Err(WorkflowError::InvalidState);
        }
        let existing = sqlx::query_as::<_, (Uuid, i32, String, Option<Uuid>)>(
            "SELECT id,revision,status,artifact_id FROM submissions WHERE release_id=$1 FOR UPDATE",
        )
        .bind(release_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        let required = if matches!(facts.1.as_str(), "capability" | "app_update") {
            2_i16
        } else {
            1_i16
        };
        let submission_id = match existing {
            Some((id, _, ref current, Some(artifact)))
                if current == "in_review" && artifact == request.artifact_id => id,
            Some((id, revision, current, _))
                if matches!(current.as_str(), "changes_requested" | "rejected" | "withdrawn") => {
                    sqlx::query("UPDATE submissions SET artifact_id=$2,revision=$3,status='in_review',required_approvals=$4, \
                        submitted_by_issuer=$5,submitted_by_subject=$6,policy_version='p4-v1',scanner_version=$7,rule_version=$8, \
                        policy_evidence=$9,submitted_at=now(),decided_at=NULL WHERE id=$1")
                        .bind(id).bind(request.artifact_id).bind(revision + 1).bind(required)
                        .bind(&principal.issuer).bind(&principal.subject).bind(&scanner_version).bind(&rule_version)
                        .bind(json!({"canonical_sha256": hex::encode(&canonical_sha256), "artifact_status": "verified"}))
                        .execute(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
                    id
                }
            Some(_) => return Err(WorkflowError::InvalidState),
            None => sqlx::query_scalar::<_, Uuid>("INSERT INTO submissions (release_id,artifact_id,status,required_approvals, \
                    submitted_by_issuer,submitted_by_subject,policy_version,scanner_version,rule_version,policy_evidence,submitted_at) \
                    VALUES ($1,$2,'in_review',$3,$4,$5,'p4-v1',$6,$7,$8,now()) RETURNING id")
                .bind(release_id).bind(request.artifact_id).bind(required).bind(&principal.issuer).bind(&principal.subject)
                .bind(&scanner_version).bind(&rule_version)
                .bind(json!({"canonical_sha256": hex::encode(&canonical_sha256), "artifact_status": "verified"}))
                .fetch_one(&mut *tx).await.map_err(|_| WorkflowError::Database)?,
        };
        sqlx::query("UPDATE releases SET status='in_review' WHERE id=$1")
            .bind(release_id)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
        sqlx::query("UPDATE packages SET status='submitted' WHERE id=$1 AND status='draft'")
            .bind(facts.0)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
        let result = load_view(&mut tx, submission_id).await?;
        record_transition(
            &mut tx,
            principal,
            "submission.submitted",
            submission_id,
            request_id,
            &result,
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }

    async fn withdraw(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
        key: &str,
        request_id: &str,
        request: &WithdrawSubmissionRequest,
    ) -> Result<SubmissionView, WorkflowError> {
        let operation = "submission.withdraw";
        let digest = idempotency::request_digest(operation, &submission_id.to_string(), request);
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
        let row = sqlx::query_as::<_, (Uuid, Uuid, String)>("SELECT s.release_id,r.package_id,s.status FROM submissions s JOIN releases r ON r.id=s.release_id WHERE s.id=$1 FOR UPDATE OF s,r")
            .bind(submission_id).fetch_optional(&mut *tx).await.map_err(|_| WorkflowError::Database)?.ok_or(WorkflowError::NotFound)?;
        if !is_package_member(&mut tx, principal, row.1).await? {
            return Err(WorkflowError::Forbidden);
        }
        if row.2 != "withdrawn" {
            if !matches!(
                row.2.as_str(),
                "in_review" | "changes_requested" | "rejected"
            ) {
                return Err(WorkflowError::InvalidState);
            }
            sqlx::query("UPDATE submissions SET status='withdrawn',decided_at=now() WHERE id=$1")
                .bind(submission_id)
                .execute(&mut *tx)
                .await
                .map_err(|_| WorkflowError::Database)?;
            sqlx::query("UPDATE releases SET status='rejected' WHERE id=$1")
                .bind(row.0)
                .execute(&mut *tx)
                .await
                .map_err(|_| WorkflowError::Database)?;
        }
        let result = load_view(&mut tx, submission_id).await?;
        record_transition(
            &mut tx,
            principal,
            "submission.withdrawn",
            submission_id,
            request_id,
            &json!({"reason": request.reason, "revision": result.revision}),
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }

    async fn queue(
        &self,
        principal: &PrincipalRef,
        filter: &super::ReviewQueueFilter,
    ) -> Result<
        (
            Vec<assetlibrary_contracts::OperatorReviewQueueItem>,
            Option<super::ReviewQueueCursor>,
        ),
        WorkflowError,
    > {
        super::operator_reads::queue(self, principal, filter).await
    }

    async fn submission_detail(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
    ) -> Result<assetlibrary_contracts::OperatorSubmissionDetail, WorkflowError> {
        super::operator_reads::submission_detail(self, principal, submission_id).await
    }

    async fn decide(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
        key: &str,
        request_id: &str,
        request: &assetlibrary_contracts::DecideReviewRequest,
    ) -> Result<assetlibrary_contracts::ReviewDecisionView, WorkflowError> {
        super::decision::decide(self, principal, submission_id, key, request_id, request).await
    }

    async fn publish(
        &self,
        principal: &PrincipalRef,
        submission_id: Uuid,
        key: &str,
        request_id: &str,
    ) -> Result<SubmissionView, WorkflowError> {
        super::publication::publish(self, principal, submission_id, key, request_id).await
    }
}

pub async fn record_transition<T: serde::Serialize>(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    action: &str,
    resource_id: Uuid,
    request_id: &str,
    details: &T,
) -> Result<(), WorkflowError> {
    sqlx::query("INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id,correlation_id,details) VALUES ($1,$2,$3,'submission',$4,$5,$6)")
        .bind(&principal.issuer).bind(&principal.subject).bind(action).bind(resource_id).bind(request_id)
        .bind(serde_json::to_value(details).map_err(|_| WorkflowError::Database)?)
        .execute(&mut **tx).await.map(|_| ()).map_err(|_| WorkflowError::Database)
}
