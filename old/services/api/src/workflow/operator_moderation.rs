use assetlibrary_contracts::{
    AppealResolution, ModerationActionKind, ModerationActionStatus, ModerationCaseStatus,
    ModerationTargetKind, OperatorModerationActionRecord, OperatorModerationAppeal,
    OperatorModerationCaseDetail, OperatorModerationCaseItem, OperatorModerationRelease,
    OperatorReviewPackage, SCHEMA_VERSION_V1,
};
use serde_json::Value;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    ModerationQueueCursor, ModerationQueueFilter, PostgresModerationRepository, WorkflowError,
    authorization::require_store_role,
};

type QueueRow = (
    Uuid,
    String,
    Value,
    Option<Value>,
    String,
    Option<String>,
    OffsetDateTime,
    OffsetDateTime,
);
type DetailFacts = (
    String,
    Value,
    Option<String>,
    Option<String>,
    Option<String>,
    Option<OffsetDateTime>,
);
type ActionRow = (
    Uuid,
    String,
    String,
    String,
    String,
    String,
    OffsetDateTime,
    Option<OffsetDateTime>,
    String,
    String,
);

pub async fn queue(
    repository: &PostgresModerationRepository,
    principal: &PrincipalRef,
    filter: &ModerationQueueFilter,
) -> Result<
    (
        Vec<OperatorModerationCaseItem>,
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
    require_store_role(&mut tx, principal, &["moderator", "operator"]).await?;
    let snapshot_at = filter
        .cursor
        .as_ref()
        .map_or_else(OffsetDateTime::now_utc, |cursor| cursor.snapshot_at);
    let created_at = filter.cursor.as_ref().map(|cursor| cursor.created_at);
    let case_id = filter.cursor.as_ref().map(|cursor| cursor.case_id);
    let mut rows = sqlx::query_as::<_, QueueRow>(&format!(
        "{} WHERE mc.status <> 'resolved' AND mc.created_at <= $1 \
         AND ($2::timestamptz IS NULL OR (mc.created_at,mc.id) > ($2,$3)) \
         ORDER BY mc.created_at,mc.id LIMIT $4",
        queue_columns()
    ))
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
        let row = rows.last().expect("non-empty bounded moderation page");
        ModerationQueueCursor {
            snapshot_at,
            created_at: row.6,
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
) -> Result<OperatorModerationCaseDetail, WorkflowError> {
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ")
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    require_store_role(&mut tx, principal, &["moderator", "operator"]).await?;
    let row = sqlx::query_as::<_, QueueRow>(&format!("{} WHERE mc.id=$1", queue_columns()))
        .bind(case_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?
        .ok_or(WorkflowError::NotFound)?;
    let item = queue_item(row)?;
    let facts = sqlx::query_as::<_, DetailFacts>(
        "SELECT reason,evidence_urls,appeal_reason,resolution,resolution_reason,resolved_at \
         FROM moderation_cases WHERE id=$1",
    )
    .bind(case_id)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let action_rows = sqlx::query_as::<_, ActionRow>(
        "SELECT id,action,target_type,target_ref,status,reason,created_at,applied_at, \
         requested_by_issuer,requested_by_subject FROM moderation_actions \
         WHERE case_id=$1 ORDER BY created_at,id LIMIT 2",
    )
    .bind(case_id)
    .fetch_all(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let actions = action_rows
        .into_iter()
        .map(|row| action_record(row, principal))
        .collect::<Result<Vec<_>, _>>()?;
    let appeal = facts
        .2
        .map(|reason| appeal_record(reason, facts.3, facts.4, facts.5))
        .transpose()?;
    let detail = OperatorModerationCaseDetail {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        can_propose: item.status == ModerationCaseStatus::Open && actions.is_empty(),
        can_resolve: item.status == ModerationCaseStatus::Appealed,
        item,
        report_reason: facts.0,
        evidence_urls: serde_json::from_value(facts.1).map_err(|_| WorkflowError::Database)?,
        actions,
        appeal,
    };
    if !detail.validate() {
        return Err(WorkflowError::Database);
    }
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(detail)
}

fn queue_columns() -> &'static str {
    "SELECT mc.id,mc.status,jsonb_build_object('id',p.id,'slug',p.slug::text,'name',p.name, \
     'kind',p.kind,'summary',p.summary,'publisher',jsonb_build_object('id',pub.id,'slug', \
     pub.slug::text,'display_name',pub.display_name)),CASE WHEN r.id IS NULL THEN NULL ELSE \
     jsonb_build_object('id',r.id,'version',r.version) END,left(mc.reason,240), \
     (SELECT ma.status FROM moderation_actions ma WHERE ma.case_id=mc.id ORDER BY ma.created_at,ma.id LIMIT 1), \
     mc.created_at,mc.updated_at FROM moderation_cases mc JOIN packages p ON p.id=mc.package_id \
     JOIN publishers pub ON pub.id=p.publisher_id LEFT JOIN releases r ON r.id=mc.release_id"
}

fn queue_item(row: QueueRow) -> Result<OperatorModerationCaseItem, WorkflowError> {
    let item = OperatorModerationCaseItem {
        id: row.0,
        status: parse_case_status(&row.1)?,
        package: serde_json::from_value::<OperatorReviewPackage>(row.2)
            .map_err(|_| WorkflowError::Database)?,
        release: row
            .3
            .map(serde_json::from_value::<OperatorModerationRelease>)
            .transpose()
            .map_err(|_| WorkflowError::Database)?,
        reason_preview: row.4,
        action_status: row.5.as_deref().map(parse_action_status).transpose()?,
        created_at: timestamp(row.6)?,
        updated_at: timestamp(row.7)?,
    };
    item.validate()
        .then_some(item)
        .ok_or(WorkflowError::Database)
}

fn action_record(
    row: ActionRow,
    principal: &PrincipalRef,
) -> Result<OperatorModerationActionRecord, WorkflowError> {
    let status = parse_action_status(&row.4)?;
    Ok(OperatorModerationActionRecord {
        id: row.0,
        action: parse_action(&row.1)?,
        target_type: parse_target(&row.2)?,
        target_ref: row.3,
        status,
        reason: row.5,
        created_at: timestamp(row.6)?,
        applied_at: row.7.map(timestamp).transpose()?,
        can_approve: status == ModerationActionStatus::Proposed
            && (row.8 != principal.issuer || row.9 != principal.subject),
    })
}

fn appeal_record(
    reason: String,
    resolution: Option<String>,
    resolution_reason: Option<String>,
    resolved_at: Option<OffsetDateTime>,
) -> Result<OperatorModerationAppeal, WorkflowError> {
    Ok(OperatorModerationAppeal {
        reason,
        resolution: resolution.as_deref().map(parse_resolution).transpose()?,
        resolution_reason,
        resolved_at: resolved_at.map(timestamp).transpose()?,
    })
}

fn parse_case_status(value: &str) -> Result<ModerationCaseStatus, WorkflowError> {
    match value {
        "open" => Ok(ModerationCaseStatus::Open),
        "actioned" => Ok(ModerationCaseStatus::Actioned),
        "appealed" => Ok(ModerationCaseStatus::Appealed),
        "resolved" => Ok(ModerationCaseStatus::Resolved),
        _ => Err(WorkflowError::Database),
    }
}

fn parse_action(value: &str) -> Result<ModerationActionKind, WorkflowError> {
    match value {
        "suspend" => Ok(ModerationActionKind::Suspend),
        "yank" => Ok(ModerationActionKind::Yank),
        "revoke" => Ok(ModerationActionKind::Revoke),
        "block" => Ok(ModerationActionKind::Block),
        _ => Err(WorkflowError::Database),
    }
}

fn parse_target(value: &str) -> Result<ModerationTargetKind, WorkflowError> {
    match value {
        "publisher" => Ok(ModerationTargetKind::Publisher),
        "package" => Ok(ModerationTargetKind::Package),
        "release" => Ok(ModerationTargetKind::Release),
        "artifact" => Ok(ModerationTargetKind::Artifact),
        "signing_key" => Ok(ModerationTargetKind::SigningKey),
        _ => Err(WorkflowError::Database),
    }
}

fn parse_action_status(value: &str) -> Result<ModerationActionStatus, WorkflowError> {
    match value {
        "proposed" => Ok(ModerationActionStatus::Proposed),
        "applied" => Ok(ModerationActionStatus::Applied),
        _ => Err(WorkflowError::Database),
    }
}

fn parse_resolution(value: &str) -> Result<AppealResolution, WorkflowError> {
    match value {
        "upheld" => Ok(AppealResolution::Upheld),
        "block_lifted" => Ok(AppealResolution::BlockLifted),
        _ => Err(WorkflowError::Database),
    }
}

fn timestamp(value: OffsetDateTime) -> Result<String, WorkflowError> {
    value.format(&Rfc3339).map_err(|_| WorkflowError::Database)
}
