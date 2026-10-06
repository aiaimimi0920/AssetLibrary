use assetlibrary_contracts::{
    ArtifactStatus, PublisherArtifactSummary, PublisherReleaseWorkspace, PublisherReviewFeedback,
    PublisherSubmissionSummary, ReviewDecision, ReviewFinding, SCHEMA_VERSION_V1, SubmissionStatus,
};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef, publisher::PostgresPublisherRepository, workflow::WorkflowError,
};

type ArtifactRow = (
    Uuid,
    String,
    String,
    Option<i64>,
    Option<String>,
    Option<String>,
    Option<Vec<u8>>,
    Option<String>,
    Option<String>,
    Option<OffsetDateTime>,
    OffsetDateTime,
    OffsetDateTime,
);
type SubmissionRow = (
    Uuid,
    Uuid,
    i32,
    String,
    i16,
    i64,
    Option<OffsetDateTime>,
    OffsetDateTime,
);
type FeedbackRow = (i32, String, String, Value, OffsetDateTime);

pub async fn get(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    release_id: Uuid,
) -> Result<PublisherReleaseWorkspace, WorkflowError> {
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    let state = sqlx::query_as::<_, (String, String, String, String)>(
        "SELECT r.status,pub.status,p.kind,pm.role FROM releases r JOIN packages p ON p.id=r.package_id \
         JOIN publishers pub ON pub.id=p.publisher_id JOIN publisher_members pm ON pm.publisher_id=pub.id \
         AND pm.principal_issuer=$2 AND pm.principal_subject=$3 AND pm.status='active' \
         WHERE r.id=$1 FOR SHARE OF r,p,pub,pm",
    )
    .bind(release_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::Forbidden)?;

    let mut artifact_rows = sqlx::query_as::<_, ArtifactRow>(
        "SELECT a.id,a.status,regexp_replace(a.object_key,'^.*/',''),a.size_bytes,a.media_type, \
         us.expected_digest->>'value',a.canonical_sha256,a.scanner_version,a.rule_version, \
         a.verified_at,a.created_at,a.updated_at FROM artifacts a LEFT JOIN upload_sessions us \
         ON us.artifact_id=a.id WHERE a.release_id=$1 ORDER BY a.created_at DESC,a.id LIMIT 101",
    )
    .bind(release_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let artifacts_truncated = artifact_rows.len() > 100;
    artifact_rows.truncate(100);
    let artifacts = artifact_rows
        .into_iter()
        .map(artifact)
        .collect::<Result<Vec<_>, _>>()?;

    let submission_row = sqlx::query_as::<_, SubmissionRow>(
        "SELECT s.id,s.artifact_id,s.revision,s.status,s.required_approvals, \
         count(rv.id) FILTER (WHERE rv.status='approved' AND rv.revision=s.revision), \
         s.submitted_at,s.updated_at FROM submissions s LEFT JOIN reviews rv ON rv.submission_id=s.id \
         WHERE s.release_id=$1 AND s.artifact_id IS NOT NULL GROUP BY s.id",
    )
    .bind(release_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let submission = submission_row.map(submission).transpose()?;
    let mut feedback_rows = sqlx::query_as::<_, FeedbackRow>(
        "SELECT rv.revision,rv.status,rv.reason,rv.findings,rv.decided_at FROM reviews rv \
         JOIN submissions s ON s.id=rv.submission_id WHERE s.release_id=$1 \
         AND rv.status IN ('approved','rejected','needs_changes') AND rv.decided_at IS NOT NULL \
         ORDER BY rv.revision DESC,rv.decided_at DESC,rv.id LIMIT 101",
    )
    .bind(release_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let feedback_truncated = feedback_rows.len() > 100;
    feedback_rows.truncate(100);
    let feedback = feedback_rows
        .into_iter()
        .map(review_feedback)
        .collect::<Result<Vec<_>, _>>()?;
    let workspace = PublisherReleaseWorkspace {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        release_id,
        artifacts,
        artifacts_truncated,
        submission,
        feedback,
        feedback_truncated,
        can_upload: state.1 == "active"
            && matches!(state.0.as_str(), "draft" | "uploading" | "rejected")
            && (state.2 != "app_update" || repository.app_updates_enabled)
            && matches!(state.3.as_str(), "owner" | "maintainer" | "release_manager"),
    };
    if !workspace.validate() {
        return Err(WorkflowError::Database);
    }
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(workspace)
}

fn artifact(row: ArtifactRow) -> Result<PublisherArtifactSummary, WorkflowError> {
    Ok(PublisherArtifactSummary {
        id: row.0,
        status: artifact_status(&row.1)?,
        file_name: row.2,
        size_bytes: u64::try_from(row.3.ok_or(WorkflowError::Database)?)
            .map_err(|_| WorkflowError::Database)?,
        media_type: row.4.ok_or(WorkflowError::Database)?,
        expected_digest: row.5,
        verified_digest: row.6.map(|value| format!("sha256:{}", hex::encode(value))),
        scanner_version: row.7,
        rule_version: row.8,
        verified_at: row.9.map(timestamp).transpose()?,
        created_at: timestamp(row.10)?,
        updated_at: timestamp(row.11)?,
    })
}

fn submission(row: SubmissionRow) -> Result<PublisherSubmissionSummary, WorkflowError> {
    Ok(PublisherSubmissionSummary {
        id: row.0,
        artifact_id: row.1,
        revision: u32::try_from(row.2).map_err(|_| WorkflowError::Database)?,
        status: submission_status(&row.3)?,
        required_approvals: u8::try_from(row.4).map_err(|_| WorkflowError::Database)?,
        approval_count: u8::try_from(row.5).map_err(|_| WorkflowError::Database)?,
        submitted_at: row.6.map(timestamp).transpose()?,
        updated_at: timestamp(row.7)?,
    })
}

fn review_feedback(row: FeedbackRow) -> Result<PublisherReviewFeedback, WorkflowError> {
    Ok(PublisherReviewFeedback {
        revision: u32::try_from(row.0).map_err(|_| WorkflowError::Database)?,
        decision: review_decision(&row.1)?,
        reason: row.2,
        findings: serde_json::from_value::<Vec<ReviewFinding>>(row.3)
            .map_err(|_| WorkflowError::Database)?,
        decided_at: timestamp(row.4)?,
    })
}

fn artifact_status(value: &str) -> Result<ArtifactStatus, WorkflowError> {
    match value {
        "pending_upload" => Ok(ArtifactStatus::PendingUpload),
        "uploaded" => Ok(ArtifactStatus::Uploaded),
        "scanning" => Ok(ArtifactStatus::Scanning),
        "verified" => Ok(ArtifactStatus::Verified),
        "quarantined" => Ok(ArtifactStatus::Quarantined),
        "deleted" => Ok(ArtifactStatus::Deleted),
        _ => Err(WorkflowError::Database),
    }
}

fn submission_status(value: &str) -> Result<SubmissionStatus, WorkflowError> {
    match value {
        "in_review" => Ok(SubmissionStatus::InReview),
        "changes_requested" => Ok(SubmissionStatus::ChangesRequested),
        "approved" => Ok(SubmissionStatus::Approved),
        "rejected" => Ok(SubmissionStatus::Rejected),
        "withdrawn" => Ok(SubmissionStatus::Withdrawn),
        _ => Err(WorkflowError::Database),
    }
}

fn review_decision(value: &str) -> Result<ReviewDecision, WorkflowError> {
    match value {
        "approved" => Ok(ReviewDecision::Approved),
        "rejected" => Ok(ReviewDecision::Rejected),
        "needs_changes" => Ok(ReviewDecision::NeedsChanges),
        _ => Err(WorkflowError::Database),
    }
}

fn timestamp(value: OffsetDateTime) -> Result<String, WorkflowError> {
    value.format(&Rfc3339).map_err(|_| WorkflowError::Database)
}
