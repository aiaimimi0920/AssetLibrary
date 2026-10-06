use assetlibrary_contracts::{OwnedPackage, PackageVisibility, UpdatePackageRequest};
use serde_json::json;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef,
    publisher::PostgresPublisherRepository,
    publisher_mutations::{audit, emit},
    publisher_queries::{PackageRow, package_contract},
    workflow::{WorkflowError, idempotency},
};

type UpdatePackageAuthorization = (String, String, String, String, OffsetDateTime, Uuid, String);

pub async fn update(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    package_id: Uuid,
    key: &str,
    request_id: &str,
    request: &UpdatePackageRequest,
) -> Result<OwnedPackage, WorkflowError> {
    let operation = "publisher.package.update";
    let digest = idempotency::request_digest(operation, &package_id.to_string(), request);
    let expected_updated_at = OffsetDateTime::parse(&request.expected_updated_at, &Rfc3339)
        .map_err(|_| WorkflowError::InvalidState)?;
    let mut tx = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let authorization = sqlx::query_as::<_, UpdatePackageAuthorization>(
        "SELECT pub.status,pm.role,p.kind,p.status,p.updated_at,p.publisher_id,p.slug::text \
         FROM packages p JOIN publishers pub ON pub.id=p.publisher_id JOIN publisher_members pm \
         ON pm.publisher_id=pub.id AND pm.principal_issuer=$2 AND pm.principal_subject=$3 \
         AND pm.status='active' WHERE p.id=$1 FOR UPDATE OF p,pub,pm",
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
    if !matches!(authorization.1.as_str(), "owner" | "maintainer") {
        return Err(WorkflowError::Forbidden);
    }
    if authorization.2 == "app_update" && !repository.app_updates_enabled {
        return Err(WorkflowError::FeatureDisabled);
    }
    if let Some(replay) = idempotency::begin(&mut tx, principal, operation, key, &digest).await? {
        return Ok(replay);
    }
    if authorization.3 != "draft" || authorization.4 != expected_updated_at {
        return Err(WorkflowError::InvalidState);
    }
    let row = sqlx::query_as::<_, PackageRow>(
        "UPDATE packages SET visibility=$2,name=$3,summary=$4,description=$5,tags=$6,updated_at=now() \
         WHERE id=$1 RETURNING id,publisher_id,slug::text,kind,status,visibility,name,summary, \
         description,tags,created_at,updated_at",
    )
    .bind(package_id)
    .bind(visibility(request.visibility))
    .bind(&request.name)
    .bind(&request.summary)
    .bind(&request.description)
    .bind(&request.tags)
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let package = package_contract(row)?;
    audit(
        &mut tx,
        principal,
        "package.updated",
        "package",
        package.id,
        request_id,
        json!({
            "publisher_id": authorization.5,
            "slug": authorization.6,
            "visibility": package.visibility,
            "tags": package.tags.len()
        }),
    )
    .await?;
    emit(
        &mut tx,
        principal,
        "assetlibrary.package.v1",
        "package",
        package.id,
        json!({
            "publisher_id": package.publisher_id,
            "package_id": package.id,
            "slug": package.slug,
            "kind": package.kind,
            "action": "updated"
        }),
    )
    .await?;
    idempotency::finish(&mut tx, principal, operation, key, &digest, &package).await?;
    tx.commit().await.map_err(|_| WorkflowError::Database)?;
    Ok(package)
}

fn visibility(value: PackageVisibility) -> &'static str {
    match value {
        PackageVisibility::Public => "public",
        PackageVisibility::Unlisted => "unlisted",
        PackageVisibility::Private => "private",
    }
}
