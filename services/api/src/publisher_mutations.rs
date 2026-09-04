use assetlibrary_contracts::{
    CreatePackageRequest, CreateReleaseRequest, OwnedPackage, OwnedRelease, PackageKind,
    PackageVisibility, UpdateReleaseRequest,
};
use serde_json::json;
use sqlx::{Postgres, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef,
    publisher::PostgresPublisherRepository,
    publisher_queries::{PackageRow, ReleaseRow, package_contract, release_contract},
    workflow::{WorkflowError, idempotency},
};

type UpdateReleaseAuthorization = (
    String,
    String,
    String,
    String,
    OffsetDateTime,
    Uuid,
    String,
    String,
);

pub async fn create_package(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    key: &str,
    request_id: &str,
    request: &CreatePackageRequest,
) -> Result<OwnedPackage, WorkflowError> {
    let operation = "publisher.package.create";
    let digest = idempotency::request_digest(operation, &publisher_id.to_string(), request);
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let authorization = sqlx::query_as::<_, (String, String)>(
        "SELECT pub.status,pm.role FROM publishers pub JOIN publisher_members pm \
         ON pm.publisher_id=pub.id AND pm.principal_issuer=$2 AND pm.principal_subject=$3 \
         AND pm.status='active' WHERE pub.id=$1 FOR UPDATE OF pub,pm",
    )
    .bind(publisher_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::Forbidden)?;
    if authorization.0 != "active" {
        return Err(WorkflowError::InvalidState);
    }
    if !matches!(authorization.1.as_str(), "owner" | "maintainer") {
        return Err(WorkflowError::Forbidden);
    }
    if matches!(&request.kind, PackageKind::AppUpdate) && !repository.app_updates_enabled {
        return Err(WorkflowError::FeatureDisabled);
    }
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    let row = sqlx::query_as::<_, PackageRow>(
        "INSERT INTO packages (publisher_id,slug,kind,status,visibility,name,summary,description,tags) \
         VALUES ($1,$2,$3,'draft',$4,$5,$6,$7,$8) RETURNING id,publisher_id,slug::text,kind,status, \
         visibility,name,summary,description,tags,created_at,updated_at",
    )
    .bind(publisher_id)
    .bind(&request.slug)
    .bind(package_kind(request.kind.clone()))
    .bind(visibility(request.visibility))
    .bind(&request.name)
    .bind(&request.summary)
    .bind(&request.description)
    .bind(&request.tags)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_insert_error)?;
    let package = package_contract(row)?;
    audit(
        &mut tx,
        principal,
        "package.created",
        "package",
        package.id,
        request_id,
        json!({"publisher_id": publisher_id, "slug": package.slug, "kind": request.kind}),
    )
    .await?;
    emit(
        &mut tx,
        principal,
        "assetlibrary.package.v1",
        "package",
        package.id,
        json!({
            "publisher_id": publisher_id,
            "package_id": package.id,
            "slug": package.slug,
            "kind": package.kind,
            "action": "created"
        }),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &package).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(package)
}

pub async fn create_release(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    package_id: Uuid,
    key: &str,
    request_id: &str,
    request: &CreateReleaseRequest,
) -> Result<OwnedRelease, WorkflowError> {
    let operation = "publisher.release.create";
    let digest = idempotency::request_digest(operation, &package_id.to_string(), request);
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let authorization = sqlx::query_as::<_, (String, String, String, String, Uuid)>(
        "SELECT pub.status,pm.role,p.kind,p.status,p.publisher_id FROM packages p JOIN publishers pub \
         ON pub.id=p.publisher_id JOIN publisher_members pm ON pm.publisher_id=pub.id \
         AND pm.principal_issuer=$2 AND pm.principal_subject=$3 AND pm.status='active' \
         WHERE p.id=$1 FOR UPDATE OF p,pub,pm",
    )
    .bind(package_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::Forbidden)?;
    if authorization.0 != "active" {
        return Err(WorkflowError::InvalidState);
    }
    if !matches!(
        authorization.1.as_str(),
        "owner" | "maintainer" | "release_manager"
    ) {
        return Err(WorkflowError::Forbidden);
    }
    if authorization.2 == "app_update" && !repository.app_updates_enabled {
        return Err(WorkflowError::FeatureDisabled);
    }
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    if !matches!(
        authorization.3.as_str(),
        "draft" | "submitted" | "published"
    ) {
        return Err(WorkflowError::InvalidState);
    }
    let compatibility =
        serde_json::to_value(&request.compatibility).map_err(|_| WorkflowError::Database)?;
    let permissions =
        serde_json::to_value(&request.permissions).map_err(|_| WorkflowError::Database)?;
    let row = sqlx::query_as::<_, ReleaseRow>(
        "INSERT INTO releases (package_id,version,status,compatibility,permissions,created_by_issuer,created_by_subject) \
         VALUES ($1,$2,'draft',$3,$4,$5,$6) RETURNING id,package_id,version,status,compatibility,permissions, \
         created_by_issuer,created_by_subject,published_at,yanked_at,created_at,updated_at",
    )
    .bind(package_id)
    .bind(&request.version)
    .bind(compatibility)
    .bind(permissions)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_one(&mut *tx)
    .await
    .map_err(map_insert_error)?;
    let release = release_contract(row)?;
    audit(
        &mut tx,
        principal,
        "release.created",
        "release",
        release.id,
        request_id,
        json!({"publisher_id": authorization.4, "package_id": package_id, "version": release.version}),
    )
    .await?;
    emit(
        &mut tx,
        principal,
        "assetlibrary.release.v1",
        "release",
        release.id,
        json!({
            "package_id": package_id,
            "release_id": release.id,
            "version": release.version,
            "action": "created"
        }),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &release).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(release)
}

pub async fn update_release(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    release_id: Uuid,
    key: &str,
    request_id: &str,
    request: &UpdateReleaseRequest,
) -> Result<OwnedRelease, WorkflowError> {
    let operation = "publisher.release.update";
    let digest = idempotency::request_digest(operation, &release_id.to_string(), request);
    let expected_updated_at = OffsetDateTime::parse(&request.expected_updated_at, &Rfc3339)
        .map_err(|_| WorkflowError::InvalidState)?;
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let authorization = sqlx::query_as::<_, UpdateReleaseAuthorization>(
        "SELECT pub.status,pm.role,p.kind,r.status,r.updated_at,r.package_id,r.version,p.status \
         FROM releases r JOIN packages p ON p.id=r.package_id JOIN publishers pub ON pub.id=p.publisher_id \
         JOIN publisher_members pm ON pm.publisher_id=pub.id AND pm.principal_issuer=$2 \
         AND pm.principal_subject=$3 AND pm.status='active' WHERE r.id=$1 FOR UPDATE OF r,p,pub,pm",
    )
    .bind(release_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::Forbidden)?;
    if authorization.0 != "active" {
        return Err(WorkflowError::InvalidState);
    }
    if !matches!(
        authorization.1.as_str(),
        "owner" | "maintainer" | "release_manager"
    ) {
        return Err(WorkflowError::Forbidden);
    }
    if authorization.2 == "app_update" && !repository.app_updates_enabled {
        return Err(WorkflowError::FeatureDisabled);
    }
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    if !matches!(
        authorization.7.as_str(),
        "draft" | "submitted" | "published"
    ) || authorization.3 != "draft"
        || authorization.4 != expected_updated_at
    {
        return Err(WorkflowError::InvalidState);
    }
    let compatibility =
        serde_json::to_value(&request.compatibility).map_err(|_| WorkflowError::Database)?;
    let permissions =
        serde_json::to_value(&request.permissions).map_err(|_| WorkflowError::Database)?;
    let row = sqlx::query_as::<_, ReleaseRow>(
        "UPDATE releases SET compatibility=$2,permissions=$3,updated_at=now() WHERE id=$1 \
         RETURNING id,package_id,version,status,compatibility,permissions,created_by_issuer, \
         created_by_subject,published_at,yanked_at,created_at,updated_at",
    )
    .bind(release_id)
    .bind(compatibility)
    .bind(permissions)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let release = release_contract(row)?;
    audit(
        &mut tx,
        principal,
        "release.updated",
        "release",
        release.id,
        request_id,
        json!({
            "package_id": authorization.5,
            "version": authorization.6,
            "compatibility_products": request.compatibility.products.len(),
            "permissions": request.permissions.len()
        }),
    )
    .await?;
    emit(
        &mut tx,
        principal,
        "assetlibrary.release.v1",
        "release",
        release.id,
        json!({
            "package_id": authorization.5,
            "release_id": release.id,
            "version": release.version,
            "action": "updated"
        }),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &release).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(release)
}

fn package_kind(value: PackageKind) -> &'static str {
    match value {
        PackageKind::Art => "art",
        PackageKind::Capability => "capability",
        PackageKind::AppUpdate => "app_update",
    }
}

fn visibility(value: PackageVisibility) -> &'static str {
    match value {
        PackageVisibility::Public => "public",
        PackageVisibility::Unlisted => "unlisted",
        PackageVisibility::Private => "private",
    }
}

fn map_insert_error(error: sqlx::Error) -> WorkflowError {
    if error
        .as_database_error()
        .and_then(|database| database.code())
        .is_some_and(|code| code == "23505")
    {
        WorkflowError::InvalidState
    } else {
        tracing::error!(?error, "publisher mutation failed");
        WorkflowError::Database
    }
}

pub(crate) async fn audit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    action: &str,
    resource_type: &str,
    resource_id: Uuid,
    request_id: &str,
    details: serde_json::Value,
) -> Result<(), WorkflowError> {
    sqlx::query(
        "INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id, \
         correlation_id,details) VALUES ($1,$2,$3,$4,$5,$6,$7)",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(action)
    .bind(resource_type)
    .bind(resource_id)
    .bind(request_id)
    .bind(details)
    .execute(&mut **tx)
    .await
    .map(|_| ())
    .map_err(|_| WorkflowError::Database)
}

pub(crate) async fn emit(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    subject: &str,
    aggregate_type: &str,
    aggregate_id: Uuid,
    mut payload: serde_json::Value,
) -> Result<(), WorkflowError> {
    let event_id = Uuid::new_v4();
    let occurred_at = OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|_| WorkflowError::Database)?;
    payload["event_id"] = json!(event_id);
    payload["occurred_at"] = json!(occurred_at);
    payload["schema_version"] = json!("1.0");
    payload["actor"] =
        json!({"type": "principal", "issuer": principal.issuer, "subject": principal.subject});
    sqlx::query(
        "INSERT INTO outbox_events (id,subject,schema_version,aggregate_type,aggregate_id,payload) \
         VALUES ($1,$2,'1.0',$3,$4,$5)",
    )
    .bind(event_id)
    .bind(subject)
    .bind(aggregate_type)
    .bind(aggregate_id)
    .bind(payload)
    .execute(&mut **tx)
    .await
    .map(|_| ())
    .map_err(|_| WorkflowError::Database)
}
