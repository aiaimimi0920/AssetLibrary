use assetlibrary_contracts::{
    PublisherModerationAppeal, PublisherModerationCaseDetail, PublisherModerationCaseItem,
    SCHEMA_VERSION_V1,
};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    ModerationQueueCursor, ModerationQueueFilter, PostgresModerationRepository, WorkflowError,
};

type QueueRow = (
    Uuid,
    String,
    Value,
    Option<Value>,
    Value,
    OffsetDateTime,
    OffsetDateTime,
);
type DetailFacts = (
    String,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<OffsetDateTime>,
);

pub async fn queue(
    repository: &PostgresModerationRepository,
    principal: &PrincipalRef,
    filter: &ModerationQueueFilter,
) -> Result<
    (
        Vec<PublisherModerationCaseItem>,
        Option<ModerationQueueCursor>,
    ),
    WorkflowError,
> {
    if !(1..=100).contains(&filter.limit) {
        return Err(WorkflowError::InvalidState);
    }
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let snapshot_at = filter
        .cursor
        .as_ref()
        .map_or_else(OffsetDateTime::now_utc, |cursor| cursor.snapshot_at);
    let created_at = filter.cursor.as_ref().map(|cursor| cursor.created_at);
    let case_id = filter.cursor.as_ref().map(|cursor| cursor.case_id);
    let mut rows = sqlx::query_as::<_, QueueRow>(&format!(
        "{} WHERE pm.principal_issuer=$1 AND pm.principal_subject=$2 AND pm.status='active' \
         AND mc.status IN ('actioned','appealed','resolved') AND mc.created_at <= $3 \
         AND ma.applied_at <= $3 \
         AND ($4::timestamptz IS NULL OR mc.created_at<$4 OR (mc.created_at=$4 AND mc.id>$5)) \
         ORDER BY mc.created_at DESC,mc.id ASC LIMIT $6 FOR SHARE OF pm",
        publisher_columns()
    ))
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(snapshot_at)
    .bind(created_at)
    .bind(case_id)
    .bind(i64::from(filter.limit) + 1)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let has_more = rows.len() > usize::from(filter.limit);
    rows.truncate(usize::from(filter.limit));
    let next = has_more.then(|| {
        let row = rows
            .last()
            .expect("non-empty bounded publisher moderation page");
        ModerationQueueCursor {
            snapshot_at,
            created_at: row.5,
            case_id: row.0,
        }
    });
    let items = rows.into_iter().map(queue_item).collect::<Result<_, _>>()?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok((items, next))
}

pub async fn case_detail(
    repository: &PostgresModerationRepository,
    principal: &PrincipalRef,
    case_id: Uuid,
) -> Result<PublisherModerationCaseDetail, WorkflowError> {
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    let item = load_item(&mut tx, principal, case_id).await?;
    let facts = sqlx::query_as::<_, DetailFacts>(
        "SELECT ma.reason,mc.appeal_reason,mc.resolution,mc.resolution_reason,mc.resolved_at \
         FROM moderation_cases mc JOIN moderation_actions ma ON ma.case_id=mc.id \
         WHERE mc.id=$1 AND ma.status='applied'",
    )
    .bind(case_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let appeal = facts
        .1
        .map(|reason| appeal_record(reason, facts.2, facts.3, facts.4))
        .transpose()?;
    let detail = PublisherModerationCaseDetail {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        can_appeal: item.status == assetlibrary_contracts::ModerationCaseStatus::Actioned,
        item,
        action_reason: facts.0,
        appeal,
    };
    if !detail.validate() {
        return Err(WorkflowError::Database);
    }
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(detail)
}

async fn load_item(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    case_id: Uuid,
) -> Result<PublisherModerationCaseItem, WorkflowError> {
    let row = sqlx::query_as::<_, QueueRow>(&format!(
        "{} WHERE mc.id=$1 AND mc.status IN ('actioned','appealed','resolved') \
         AND pm.principal_issuer=$2 AND pm.principal_subject=$3 AND pm.status='active' \
         FOR SHARE OF pm",
        publisher_columns()
    ))
    .bind(case_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    queue_item(row)
}

fn publisher_columns() -> &'static str {
    "SELECT mc.id,mc.status,jsonb_build_object('id',p.id,'publisher_id',p.publisher_id, \
     'slug',p.slug::text,'name',p.name,'kind',p.kind),CASE WHEN r.id IS NULL THEN NULL ELSE \
     jsonb_build_object('id',r.id,'version',r.version) END,jsonb_build_object('id',ma.id, \
     'action',ma.action,'target_type',ma.target_type,'target_ref',ma.target_ref,'status',ma.status, \
     'reason_preview',left(ma.reason,240),'applied_at',ma.applied_at),mc.created_at,mc.updated_at \
     FROM moderation_cases mc JOIN packages p ON p.id=mc.package_id \
     JOIN publisher_members pm ON pm.publisher_id=p.publisher_id \
     JOIN moderation_actions ma ON ma.case_id=mc.id AND ma.status='applied' \
     LEFT JOIN releases r ON r.id=mc.release_id"
}

fn queue_item(row: QueueRow) -> Result<PublisherModerationCaseItem, WorkflowError> {
    let item = PublisherModerationCaseItem {
        id: row.0,
        status: parse_case_status(&row.1)?,
        package: serde_json::from_value(row.2).map_err(|_| WorkflowError::Database)?,
        release: row
            .3
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| WorkflowError::Database)?,
        action: serde_json::from_value(row.4).map_err(|_| WorkflowError::Database)?,
        created_at: timestamp(row.5)?,
        updated_at: timestamp(row.6)?,
    };
    item.validate()
        .then_some(item)
        .ok_or(WorkflowError::Database)
}

fn appeal_record(
    reason: String,
    resolution: Option<String>,
    resolution_reason: Option<String>,
    resolved_at: Option<OffsetDateTime>,
) -> Result<PublisherModerationAppeal, WorkflowError> {
    Ok(PublisherModerationAppeal {
        reason,
        resolution: resolution.as_deref().map(parse_resolution).transpose()?,
        resolution_reason,
        resolved_at: resolved_at.map(timestamp).transpose()?,
    })
}

fn parse_case_status(
    value: &str,
) -> Result<assetlibrary_contracts::ModerationCaseStatus, WorkflowError> {
    match value {
        "actioned" => Ok(assetlibrary_contracts::ModerationCaseStatus::Actioned),
        "appealed" => Ok(assetlibrary_contracts::ModerationCaseStatus::Appealed),
        "resolved" => Ok(assetlibrary_contracts::ModerationCaseStatus::Resolved),
        _ => Err(WorkflowError::Database),
    }
}

fn parse_resolution(
    value: &str,
) -> Result<assetlibrary_contracts::AppealResolution, WorkflowError> {
    match value {
        "upheld" => Ok(assetlibrary_contracts::AppealResolution::Upheld),
        "block_lifted" => Ok(assetlibrary_contracts::AppealResolution::BlockLifted),
        _ => Err(WorkflowError::Database),
    }
}

fn timestamp(value: OffsetDateTime) -> Result<String, WorkflowError> {
    value.format(&Rfc3339).map_err(|_| WorkflowError::Database)
}
