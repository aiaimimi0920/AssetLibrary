use assetlibrary_contracts::{
    AppealModerationRequest, AppealResolution, ModerationActionKind, ModerationActionStatus,
    ModerationActionView, ModerationCaseStatus, ModerationCaseView, ModerationTargetKind,
    ProposeModerationActionRequest, ReportPackageRequest, ResolveModerationRequest,
};
use async_trait::async_trait;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::{
    ModerationRepository, WorkflowError,
    authorization::{is_package_member, require_store_role},
    idempotency,
    publication::emit,
};

pub struct PostgresModerationRepository {
    pub(super) pool: PgPool,
}

impl PostgresModerationRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[async_trait]
impl ModerationRepository for PostgresModerationRepository {
    async fn queue(
        &self,
        principal: &PrincipalRef,
        filter: &super::ModerationQueueFilter,
    ) -> Result<
        (
            Vec<assetlibrary_contracts::OperatorModerationCaseItem>,
            Option<super::ModerationQueueCursor>,
        ),
        WorkflowError,
    > {
        super::operator_moderation::queue(self, principal, filter).await
    }

    async fn case_detail(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
    ) -> Result<assetlibrary_contracts::OperatorModerationCaseDetail, WorkflowError> {
        super::operator_moderation::case_detail(self, principal, case_id).await
    }

    async fn publisher_queue(
        &self,
        principal: &PrincipalRef,
        filter: &super::ModerationQueueFilter,
    ) -> Result<
        (
            Vec<assetlibrary_contracts::PublisherModerationCaseItem>,
            Option<super::ModerationQueueCursor>,
        ),
        WorkflowError,
    > {
        super::publisher_moderation::queue(self, principal, filter).await
    }

    async fn publisher_case_detail(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
    ) -> Result<assetlibrary_contracts::PublisherModerationCaseDetail, WorkflowError> {
        super::publisher_moderation::case_detail(self, principal, case_id).await
    }

    async fn report(
        &self,
        principal: &PrincipalRef,
        package_id: Uuid,
        key: &str,
        request_id: &str,
        request: &ReportPackageRequest,
    ) -> Result<ModerationCaseView, WorkflowError> {
        let operation = "moderation.report";
        let digest = idempotency::request_digest(operation, &package_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        if let Some(value) = idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(value);
        }
        let valid = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM packages p WHERE p.id=$1 AND \
            ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM releases r WHERE r.id=$2 AND r.package_id=p.id)))")
            .bind(package_id).bind(request.release_id).fetch_one(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
        if !valid {
            return Err(WorkflowError::NotFound);
        }
        let id = sqlx::query_scalar::<_, Uuid>("INSERT INTO moderation_cases (package_id,release_id,status,reason,evidence, \
            reporter_issuer,reporter_subject,evidence_urls) VALUES ($1,$2,'open',$3,'{}',$4,$5,$6) RETURNING id")
            .bind(package_id).bind(request.release_id).bind(&request.reason).bind(&principal.issuer).bind(&principal.subject)
            .bind(json!(request.evidence_urls)).fetch_one(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
        let result = ModerationCaseView {
            id,
            package_id,
            release_id: request.release_id,
            status: ModerationCaseStatus::Open,
        };
        audit(
            &mut tx,
            principal,
            "moderation.reported",
            "moderation_case",
            id,
            request_id,
            &json!({"package_id": package_id, "release_id": request.release_id}),
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }

    async fn propose(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
        key: &str,
        request_id: &str,
        request: &ProposeModerationActionRequest,
    ) -> Result<ModerationActionView, WorkflowError> {
        let operation = "moderation.propose";
        let digest = idempotency::request_digest(operation, &case_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        if let Some(value) = idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(value);
        }
        require_store_role(&mut tx, principal, &["moderator", "operator"]).await?;
        let package_id = sqlx::query_scalar::<_, Uuid>(
            "SELECT package_id FROM moderation_cases WHERE id=$1 AND status='open' FOR UPDATE",
        )
        .bind(case_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?
        .ok_or(WorkflowError::InvalidState)?;
        if !target_belongs(
            &mut tx,
            package_id,
            request.target_type,
            &request.target_ref,
        )
        .await?
        {
            return Err(WorkflowError::InvalidState);
        }
        let action = action_name(request.action);
        let target = target_name(request.target_type);
        let id = sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO moderation_actions (case_id,action,target_type,target_ref,reason, \
            requested_by_issuer,requested_by_subject) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id",
        )
        .bind(case_id)
        .bind(action)
        .bind(target)
        .bind(&request.target_ref)
        .bind(&request.reason)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .fetch_one(&mut *tx)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .is_some_and(|value| value.is_unique_violation())
            {
                WorkflowError::InvalidState
            } else {
                WorkflowError::Database
            }
        })?;
        let result = ModerationActionView {
            id,
            case_id,
            action: request.action,
            target_type: request.target_type,
            target_ref: request.target_ref.clone(),
            status: ModerationActionStatus::Proposed,
        };
        audit(
            &mut tx,
            principal,
            "moderation.action_proposed",
            "moderation_action",
            id,
            request_id,
            &result,
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }

    async fn approve(
        &self,
        principal: &PrincipalRef,
        action_id: Uuid,
        key: &str,
        request_id: &str,
    ) -> Result<ModerationActionView, WorkflowError> {
        let operation = "moderation.approve";
        let digest = idempotency::request_digest(operation, &action_id.to_string(), &());
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        if let Some(value) = idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(value);
        }
        require_store_role(&mut tx, principal, &["moderator", "operator"]).await?;
        let row = sqlx::query_as::<_, (Uuid, Uuid, String, String, String, String, String, String, String)>("SELECT ma.case_id,mc.package_id, \
            ma.action,ma.target_type,ma.target_ref,ma.status,mc.status,ma.requested_by_issuer,ma.requested_by_subject \
            FROM moderation_actions ma JOIN moderation_cases mc ON mc.id=ma.case_id WHERE ma.id=$1 FOR UPDATE OF ma,mc")
            .bind(action_id).fetch_optional(&mut *tx).await.map_err(|_| WorkflowError::Database)?.ok_or(WorkflowError::NotFound)?;
        let action = parse_action(&row.2)?;
        let target = parse_target(&row.3)?;
        let result = ModerationActionView {
            id: action_id,
            case_id: row.0,
            action,
            target_type: target,
            target_ref: row.4.clone(),
            status: if row.5 == "applied" {
                ModerationActionStatus::Applied
            } else {
                ModerationActionStatus::Proposed
            },
        };
        if row.5 == "applied" {
            if !matches!(row.6.as_str(), "actioned" | "appealed" | "resolved") {
                return Err(WorkflowError::Database);
            }
            idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
            tx.commit().await.map_err(|_| WorkflowError::Database)?;
            return Ok(result);
        }
        if row.5 != "proposed" || row.6 != "open" {
            return Err(WorkflowError::InvalidState);
        }
        if row.7 == principal.issuer && row.8 == principal.subject {
            return Err(WorkflowError::Forbidden);
        }
        if !target_belongs(&mut tx, row.1, target, &row.4).await? {
            return Err(WorkflowError::InvalidState);
        }
        let active = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM blocklist_entries WHERE target_type=$1 AND target_ref=$2 AND status='active')")
            .bind(&row.3).bind(&row.4).fetch_one(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
        if active {
            return Err(WorkflowError::InvalidState);
        }
        apply_action(&mut tx, row.1, action, target, &row.4).await?;
        sqlx::query(
            "INSERT INTO blocklist_entries (target_type,target_ref,reason,source_action_id) \
            SELECT target_type,target_ref,reason,id FROM moderation_actions WHERE id=$1",
        )
        .bind(action_id)
        .execute(&mut *tx)
        .await
        .map_err(|error| {
            if error
                .as_database_error()
                .is_some_and(|value| value.is_unique_violation())
            {
                WorkflowError::InvalidState
            } else {
                WorkflowError::Database
            }
        })?;
        sqlx::query("UPDATE moderation_actions SET status='applied',approved_by_issuer=$2,approved_by_subject=$3,applied_at=now() WHERE id=$1")
            .bind(action_id).bind(&principal.issuer).bind(&principal.subject).execute(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
        sqlx::query("UPDATE moderation_cases SET status='actioned' WHERE id=$1")
            .bind(row.0)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
        emit(&mut tx, "assetlibrary.policy.changed.v1", "moderation_case", row.0,
            json!({"case_id": row.0, "action_id": action_id, "action": action, "target_type": target, "target_ref": row.4})).await?;
        emit(
            &mut tx,
            "assetlibrary.catalog.invalidated.v1",
            "package",
            row.1,
            json!({"package_id": row.1, "reason": "moderation_action"}),
        )
        .await?;
        let applied = ModerationActionView {
            status: ModerationActionStatus::Applied,
            ..result
        };
        audit(
            &mut tx,
            principal,
            "moderation.action_applied",
            "moderation_action",
            action_id,
            request_id,
            &applied,
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &applied).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(applied)
    }

    async fn appeal(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
        key: &str,
        request_id: &str,
        request: &AppealModerationRequest,
    ) -> Result<ModerationCaseView, WorkflowError> {
        let operation = "moderation.appeal";
        let digest = idempotency::request_digest(operation, &case_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        if let Some(value) = idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(value);
        }
        let row = case_row(&mut tx, case_id).await?;
        if !is_package_member(&mut tx, principal, row.0).await? {
            return Err(WorkflowError::Forbidden);
        }
        if row.2 != "actioned" {
            return Err(WorkflowError::InvalidState);
        }
        sqlx::query("UPDATE moderation_cases SET status='appealed',appeal_reason=$2 WHERE id=$1")
            .bind(case_id)
            .bind(&request.reason)
            .execute(&mut *tx)
            .await
            .map_err(|_| WorkflowError::Database)?;
        let result = ModerationCaseView {
            id: case_id,
            package_id: row.0,
            release_id: row.1,
            status: ModerationCaseStatus::Appealed,
        };
        audit(
            &mut tx,
            principal,
            "moderation.appealed",
            "moderation_case",
            case_id,
            request_id,
            &json!({"reason": request.reason}),
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }

    async fn resolve(
        &self,
        principal: &PrincipalRef,
        case_id: Uuid,
        key: &str,
        request_id: &str,
        request: &ResolveModerationRequest,
    ) -> Result<ModerationCaseView, WorkflowError> {
        let operation = "moderation.resolve";
        let digest = idempotency::request_digest(operation, &case_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        if let Some(value) = idempotency::begin(&mut tx, principal, operation, key, &digest).await?
        {
            return Ok(value);
        }
        require_store_role(&mut tx, principal, &["moderator", "operator"]).await?;
        let row = case_row(&mut tx, case_id).await?;
        if row.2 != "appealed" {
            return Err(WorkflowError::InvalidState);
        }
        let resolution = match request.resolution {
            AppealResolution::Upheld => "upheld",
            AppealResolution::BlockLifted => "block_lifted",
        };
        if request.resolution == AppealResolution::BlockLifted {
            sqlx::query("UPDATE blocklist_entries b SET status='lifted',lifted_at=now() FROM moderation_actions a \
                WHERE b.source_action_id=a.id AND a.case_id=$1 AND b.status='active'")
                .bind(case_id).execute(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
            emit(
                &mut tx,
                "assetlibrary.catalog.invalidated.v1",
                "package",
                row.0,
                json!({"package_id": row.0, "reason": "block_lifted"}),
            )
            .await?;
        }
        sqlx::query("UPDATE moderation_cases SET status='resolved',resolution=$2,resolution_reason=$3,resolved_at=now() WHERE id=$1")
            .bind(case_id).bind(resolution).bind(&request.reason).execute(&mut *tx).await.map_err(|_| WorkflowError::Database)?;
        emit(
            &mut tx,
            "assetlibrary.policy.changed.v1",
            "moderation_case",
            case_id,
            json!({"case_id": case_id, "resolution": resolution}),
        )
        .await?;
        let result = ModerationCaseView {
            id: case_id,
            package_id: row.0,
            release_id: row.1,
            status: ModerationCaseStatus::Resolved,
        };
        audit(
            &mut tx,
            principal,
            "moderation.resolved",
            "moderation_case",
            case_id,
            request_id,
            &json!({"resolution": resolution, "reason": request.reason}),
        )
        .await?;
        idempotency::finish(&mut tx, principal, operation, key, &digest, &result).await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        Ok(result)
    }
}

async fn case_row(
    tx: &mut Transaction<'_, Postgres>,
    id: Uuid,
) -> Result<(Uuid, Option<Uuid>, String), WorkflowError> {
    sqlx::query_as(
        "SELECT package_id,release_id,status FROM moderation_cases WHERE id=$1 FOR UPDATE",
    )
    .bind(id)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)
}

async fn target_belongs(
    tx: &mut Transaction<'_, Postgres>,
    package_id: Uuid,
    target: ModerationTargetKind,
    value: &str,
) -> Result<bool, WorkflowError> {
    let valid = match target {
        ModerationTargetKind::Publisher => Uuid::parse_str(value).ok().map(|id| ("SELECT EXISTS(SELECT 1 FROM packages WHERE id=$1 AND publisher_id=$2)", id)),
        ModerationTargetKind::Package => Uuid::parse_str(value).ok().map(|id| ("SELECT $1::uuid=$2", id)),
        ModerationTargetKind::Release => Uuid::parse_str(value).ok().map(|id| ("SELECT EXISTS(SELECT 1 FROM releases WHERE package_id=$1 AND id=$2)", id)),
        ModerationTargetKind::Artifact => Uuid::parse_str(value).ok().map(|id| ("SELECT EXISTS(SELECT 1 FROM artifacts a JOIN releases r ON r.id=a.release_id WHERE r.package_id=$1 AND a.id=$2)", id)),
        ModerationTargetKind::SigningKey => None,
    };
    if let Some((query, id)) = valid {
        return sqlx::query_scalar(query)
            .bind(package_id)
            .bind(id)
            .fetch_one(&mut **tx)
            .await
            .map_err(|_| WorkflowError::Database);
    }
    if target != ModerationTargetKind::SigningKey || value.len() > 197 {
        return Ok(false);
    }
    let Some((publisher, key_id)) = value.split_once(':') else {
        return Ok(false);
    };
    let Ok(publisher_id) = Uuid::parse_str(publisher) else {
        return Ok(false);
    };
    if key_id.is_empty() || key_id.len() > 160 {
        return Ok(false);
    }
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM packages p JOIN publisher_signing_keys k ON k.publisher_id=p.publisher_id \
        WHERE p.id=$1 AND p.publisher_id=$2 AND k.key_id=$3)")
        .bind(package_id).bind(publisher_id).bind(key_id).fetch_one(&mut **tx).await.map_err(|_| WorkflowError::Database)
}

async fn apply_action(
    tx: &mut Transaction<'_, Postgres>,
    package_id: Uuid,
    action: ModerationActionKind,
    target: ModerationTargetKind,
    value: &str,
) -> Result<(), WorkflowError> {
    match (action, target) {
        (ModerationActionKind::Suspend, ModerationTargetKind::Publisher) => sqlx::query("UPDATE publishers SET status='suspended' WHERE id=$1").bind(Uuid::parse_str(value).map_err(|_| WorkflowError::InvalidState)?).execute(&mut **tx).await,
        (ModerationActionKind::Suspend, ModerationTargetKind::Package) => sqlx::query("UPDATE packages SET status='suspended' WHERE id=$1").bind(Uuid::parse_str(value).map_err(|_| WorkflowError::InvalidState)?).execute(&mut **tx).await,
        (ModerationActionKind::Yank, ModerationTargetKind::Release) => sqlx::query("UPDATE releases SET status='yanked',yanked_at=COALESCE(yanked_at,now()) WHERE id=$1").bind(Uuid::parse_str(value).map_err(|_| WorkflowError::InvalidState)?).execute(&mut **tx).await,
        (ModerationActionKind::Revoke, ModerationTargetKind::SigningKey) => {
            let key_id = value.split_once(':').map(|(_, key)| key).ok_or(WorkflowError::InvalidState)?;
            sqlx::query("UPDATE publisher_signing_keys k SET status='revoked',revoked_at=COALESCE(revoked_at,now()) FROM packages p WHERE p.id=$1 AND k.publisher_id=p.publisher_id AND k.key_id=$2").bind(package_id).bind(key_id).execute(&mut **tx).await
        },
        // Artifacts have lifecycle states, not a synthetic "revoked" state. The active
        // blocklist entry written by approve() is the canonical enforcement fact here.
        (ModerationActionKind::Revoke, ModerationTargetKind::Artifact) | (ModerationActionKind::Block, _) => return Ok(()),
        _ => return Err(WorkflowError::InvalidState),
    }.map(|_| ()).map_err(|_| WorkflowError::Database)
}

async fn audit<T: serde::Serialize>(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    action: &str,
    resource_type: &str,
    resource_id: Uuid,
    request_id: &str,
    details: &T,
) -> Result<(), WorkflowError> {
    sqlx::query("INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id,correlation_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7)")
        .bind(&principal.issuer).bind(&principal.subject).bind(action).bind(resource_type).bind(resource_id).bind(request_id)
        .bind(serde_json::to_value(details).map_err(|_| WorkflowError::Database)?)
        .execute(&mut **tx).await.map(|_| ()).map_err(|_| WorkflowError::Database)
}

fn action_name(value: ModerationActionKind) -> &'static str {
    match value {
        ModerationActionKind::Suspend => "suspend",
        ModerationActionKind::Yank => "yank",
        ModerationActionKind::Revoke => "revoke",
        ModerationActionKind::Block => "block",
    }
}
fn target_name(value: ModerationTargetKind) -> &'static str {
    match value {
        ModerationTargetKind::Publisher => "publisher",
        ModerationTargetKind::Package => "package",
        ModerationTargetKind::Release => "release",
        ModerationTargetKind::Artifact => "artifact",
        ModerationTargetKind::SigningKey => "signing_key",
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
