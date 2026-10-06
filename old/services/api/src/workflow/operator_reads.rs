use assetlibrary_contracts::{
    OperatorArtifactEvidence, OperatorReviewPackage, OperatorReviewQueueItem, OperatorReviewRecord,
    OperatorSubmissionDetail, PublicCompatibility, ReviewDecision, ReviewFinding,
    SCHEMA_VERSION_V1,
};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    PostgresReviewRepository, ReviewQueueCursor, ReviewQueueFilter, WorkflowError,
    authorization::{is_package_member, require_store_role},
    submission,
};

type QueueRow = (
    Uuid,
    Uuid,
    Uuid,
    i32,
    String,
    i16,
    i64,
    String,
    String,
    Value,
    String,
    OffsetDateTime,
    OffsetDateTime,
);

type DetailFacts = (
    Value,
    Value,
    Vec<u8>,
    i64,
    String,
    String,
    Option<String>,
    Option<String>,
    Uuid,
);
type ReviewRow = (Uuid, i32, String, String, Value, OffsetDateTime);

pub async fn queue(
    repository: &PostgresReviewRepository,
    principal: &PrincipalRef,
    filter: &ReviewQueueFilter,
) -> Result<(Vec<OperatorReviewQueueItem>, Option<ReviewQueueCursor>), WorkflowError> {
    if !(1..=100).contains(&filter.limit) {
        return Err(WorkflowError::InvalidState);
    }
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    require_store_role(&mut tx, principal, &["reviewer", "operator"]).await?;
    let snapshot_at = filter
        .cursor
        .as_ref()
        .map_or_else(OffsetDateTime::now_utc, |cursor| cursor.snapshot_at);
    let submitted_at = filter.cursor.as_ref().map(|cursor| cursor.submitted_at);
    let submission_id = filter.cursor.as_ref().map(|cursor| cursor.submission_id);
    let mut rows = sqlx::query_as::<_, QueueRow>(&format!(
        "{} AND s.status='in_review' AND s.submitted_at <= $1 \
         AND ($2::timestamptz IS NULL OR (s.submitted_at,s.id) > ($2,$3)) \
         ORDER BY s.submitted_at,s.id LIMIT $4",
        queue_columns()
    ))
    .bind(snapshot_at)
    .bind(submitted_at)
    .bind(submission_id)
    .bind(i64::from(filter.limit) + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let has_more = rows.len() > usize::from(filter.limit);
    rows.truncate(usize::from(filter.limit));
    let next = has_more.then(|| {
        let row = rows.last().expect("non-empty bounded review page");
        ReviewQueueCursor {
            snapshot_at,
            submitted_at: row.11,
            submission_id: row.0,
        }
    });
    let items = rows.into_iter().map(queue_item).collect::<Result<_, _>>()?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok((items, next))
}

pub async fn submission_detail(
    repository: &PostgresReviewRepository,
    principal: &PrincipalRef,
    submission_id: Uuid,
) -> Result<OperatorSubmissionDetail, WorkflowError> {
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    require_store_role(&mut tx, principal, &["reviewer", "operator"]).await?;
    let row = sqlx::query_as::<_, QueueRow>(&format!("{} AND s.id=$1", queue_columns()))
        .bind(submission_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?
        .ok_or(WorkflowError::NotFound)?;
    let item = queue_item(row)?;
    let facts = sqlx::query_as::<_, DetailFacts>(
        "SELECT r.compatibility,r.permissions,a.canonical_sha256,a.size_bytes,a.media_type, \
         s.policy_version,s.submitted_by_issuer,s.submitted_by_subject,r.package_id \
         FROM submissions s JOIN releases r ON r.id=s.release_id JOIN artifacts a ON a.id=s.artifact_id \
         WHERE s.id=$1 AND a.canonical_sha256 IS NOT NULL AND a.size_bytes IS NOT NULL \
         AND a.media_type IS NOT NULL AND s.policy_version IS NOT NULL",
    )
    .bind(submission_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    let review_rows = sqlx::query_as::<_, ReviewRow>(
        "SELECT id,revision,status,reason,findings,decided_at FROM reviews \
         WHERE submission_id=$1 AND revision=$2 AND decided_at IS NOT NULL \
         AND status IN ('approved','rejected','needs_changes') ORDER BY decided_at,id LIMIT 100",
    )
    .bind(submission_id)
    .bind(i32::try_from(item.submission.revision).map_err(|_| WorkflowError::Database)?)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let already_reviewed = sqlx::query_scalar::<_, bool>(
        "SELECT EXISTS(SELECT 1 FROM reviews WHERE submission_id=$1 AND revision=$2 \
         AND reviewer_issuer=$3 AND reviewer_subject=$4)",
    )
    .bind(submission_id)
    .bind(i32::try_from(item.submission.revision).map_err(|_| WorkflowError::Database)?)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let is_submitter = facts.6.as_deref() == Some(principal.issuer.as_str())
        && facts.7.as_deref() == Some(principal.subject.as_str());
    let package_member = is_package_member(&mut tx, principal, facts.8).await?;
    let can_review = item.submission.status == assetlibrary_contracts::SubmissionStatus::InReview
        && !is_submitter
        && !package_member
        && !already_reviewed;
    let detail = OperatorSubmissionDetail {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        item,
        compatibility: serde_json::from_value::<PublicCompatibility>(facts.0)
            .map_err(|_| WorkflowError::Database)?,
        permissions: serde_json::from_value::<Vec<String>>(facts.1)
            .map_err(|_| WorkflowError::Database)?,
        evidence: OperatorArtifactEvidence {
            digest: format!("sha256:{}", hex::encode(facts.2)),
            size_bytes: u64::try_from(facts.3).map_err(|_| WorkflowError::Database)?,
            media_type: facts.4,
            policy_version: facts.5,
        },
        reviews: review_rows
            .into_iter()
            .map(review_record)
            .collect::<Result<_, _>>()?,
        can_review,
    };
    if !detail.validate() {
        return Err(WorkflowError::Database);
    }
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(detail)
}

fn queue_columns() -> &'static str {
    "SELECT s.id,s.release_id,s.artifact_id,s.revision,s.status,s.required_approvals, \
     (SELECT count(*) FROM reviews rv WHERE rv.submission_id=s.id AND rv.revision=s.revision AND rv.status='approved'), \
     s.scanner_version,s.rule_version,jsonb_build_object('id',p.id,'slug',p.slug::text,'name',p.name, \
     'kind',p.kind,'summary',p.summary,'publisher',jsonb_build_object('id',pub.id,'slug',pub.slug::text, \
     'display_name',pub.display_name)),r.version,s.submitted_at,s.updated_at FROM submissions s \
     JOIN releases r ON r.id=s.release_id JOIN packages p ON p.id=r.package_id \
     JOIN publishers pub ON pub.id=p.publisher_id WHERE s.artifact_id IS NOT NULL \
     AND s.scanner_version IS NOT NULL AND s.rule_version IS NOT NULL AND s.submitted_at IS NOT NULL"
}

fn queue_item(row: QueueRow) -> Result<OperatorReviewQueueItem, WorkflowError> {
    let item = OperatorReviewQueueItem {
        submission: submission::view((
            row.0, row.1, row.2, row.3, row.4, row.5, row.6, row.7, row.8,
        ))?,
        package: serde_json::from_value::<OperatorReviewPackage>(row.9)
            .map_err(|_| WorkflowError::Database)?,
        release_version: row.10,
        submitted_at: timestamp(row.11)?,
        updated_at: timestamp(row.12)?,
    };
    item.validate()
        .then_some(item)
        .ok_or(WorkflowError::Database)
}

fn review_record(row: ReviewRow) -> Result<OperatorReviewRecord, WorkflowError> {
    Ok(OperatorReviewRecord {
        id: row.0,
        revision: u32::try_from(row.1).map_err(|_| WorkflowError::Database)?,
        decision: match row.2.as_str() {
            "approved" => ReviewDecision::Approved,
            "rejected" => ReviewDecision::Rejected,
            "needs_changes" => ReviewDecision::NeedsChanges,
            _ => return Err(WorkflowError::Database),
        },
        reason: row.3,
        findings: serde_json::from_value::<Vec<ReviewFinding>>(row.4)
            .map_err(|_| WorkflowError::Database)?,
        decided_at: timestamp(row.5)?,
    })
}

fn timestamp(value: OffsetDateTime) -> Result<String, WorkflowError> {
    value.format(&Rfc3339).map_err(|_| WorkflowError::Database)
}
