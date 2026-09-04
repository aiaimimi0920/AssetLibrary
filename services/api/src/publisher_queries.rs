use assetlibrary_contracts::{
    OwnedPackage, OwnedPackageStatus, OwnedPackageSummary, OwnedRelease, OwnedReleaseStatus,
    PackageKind, PackageVisibility, PrincipalRef as ContractPrincipalRef, PublicCompatibility,
    PublisherMembership, PublisherRole, PublisherState, PublisherSummary,
};
use serde_json::Value;
use sqlx::{Postgres, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    identity::PrincipalRef,
    publisher::{
        MembershipCursor, PackageCursor, PageFilter, PostgresPublisherRepository, ReleaseCursor,
    },
    workflow::WorkflowError,
};

pub(crate) type PackageRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    Vec<String>,
    OffsetDateTime,
    OffsetDateTime,
);

type PackageSummaryRow = (
    Uuid,
    Uuid,
    String,
    String,
    String,
    String,
    String,
    String,
    Vec<String>,
    OffsetDateTime,
    OffsetDateTime,
);

pub(crate) type ReleaseRow = (
    Uuid,
    Uuid,
    String,
    String,
    Value,
    Value,
    String,
    String,
    Option<OffsetDateTime>,
    Option<OffsetDateTime>,
    OffsetDateTime,
    OffsetDateTime,
);

pub async fn list_memberships(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    filter: &PageFilter<MembershipCursor>,
) -> Result<(Vec<PublisherMembership>, Option<MembershipCursor>), WorkflowError> {
    let mut rows = sqlx::query_as::<_, (Uuid, String, String, String, String)>(
        "SELECT pub.id,pub.slug::text,pub.display_name,pub.status,pm.role FROM publisher_members pm \
         JOIN publishers pub ON pub.id=pm.publisher_id WHERE pm.principal_issuer=$1 \
         AND pm.principal_subject=$2 AND pm.status='active' \
         AND ($3::uuid IS NULL OR pub.id>$3) ORDER BY pub.id LIMIT $4",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(filter.cursor.as_ref().map(|cursor| cursor.publisher_id))
    .bind(i64::from(filter.limit) + 1)
    .fetch_all(&repository.pool)
    .await
    .map_err(|_| WorkflowError::Database)?;
    let has_more = rows.len() > usize::from(filter.limit);
    rows.truncate(usize::from(filter.limit));
    let next = has_more.then(|| MembershipCursor {
        publisher_id: rows.last().expect("non-empty bounded page").0,
    });
    let items = rows
        .into_iter()
        .map(|row| {
            let item = PublisherMembership {
                publisher: PublisherSummary {
                    id: row.0,
                    slug: row.1,
                    display_name: row.2,
                },
                publisher_status: publisher_state(&row.3)?,
                role: publisher_role(&row.4)?,
            };
            item.validate()
                .then_some(item)
                .ok_or(WorkflowError::Database)
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, next))
}

pub async fn list_packages(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    filter: &PageFilter<PackageCursor>,
) -> Result<(Vec<OwnedPackageSummary>, Option<PackageCursor>), WorkflowError> {
    let mut transaction = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    lock_publisher_membership(&mut transaction, principal, publisher_id).await?;
    let mut rows = sqlx::query_as::<_, PackageSummaryRow>(
        "SELECT id,publisher_id,slug::text,kind,status,visibility,name,summary,tags,created_at,updated_at \
         FROM packages WHERE publisher_id=$1 AND ($2::timestamptz IS NULL OR updated_at<$2 \
         OR (updated_at=$2 AND id>$3)) ORDER BY updated_at DESC,id LIMIT $4",
    )
    .bind(publisher_id)
    .bind(filter.cursor.as_ref().map(|cursor| cursor.updated_at))
    .bind(filter.cursor.as_ref().map(|cursor| cursor.package_id))
    .bind(i64::from(filter.limit) + 1)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|_| WorkflowError::Database)?;
    transaction
        .commit()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let has_more = rows.len() > usize::from(filter.limit);
    rows.truncate(usize::from(filter.limit));
    let next = has_more.then(|| {
        let row = rows.last().expect("non-empty bounded page");
        PackageCursor {
            updated_at: row.10,
            package_id: row.0,
        }
    });
    let items = rows
        .into_iter()
        .map(package_summary_contract)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, next))
}

pub async fn list_releases(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    package_id: Uuid,
    filter: &PageFilter<ReleaseCursor>,
) -> Result<(Vec<OwnedRelease>, Option<ReleaseCursor>), WorkflowError> {
    let mut transaction = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    lock_package_membership(&mut transaction, principal, package_id).await?;
    let mut rows = sqlx::query_as::<_, ReleaseRow>(
        "SELECT id,package_id,version,status,compatibility,permissions,created_by_issuer, \
         created_by_subject,published_at,yanked_at,created_at,updated_at FROM releases \
         WHERE package_id=$1 AND ($2::timestamptz IS NULL OR created_at<$2 \
         OR (created_at=$2 AND id>$3)) ORDER BY created_at DESC,id LIMIT $4",
    )
    .bind(package_id)
    .bind(filter.cursor.as_ref().map(|cursor| cursor.created_at))
    .bind(filter.cursor.as_ref().map(|cursor| cursor.release_id))
    .bind(i64::from(filter.limit) + 1)
    .fetch_all(&mut *transaction)
    .await
    .map_err(|_| WorkflowError::Database)?;
    transaction
        .commit()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let has_more = rows.len() > usize::from(filter.limit);
    rows.truncate(usize::from(filter.limit));
    let next = has_more.then(|| {
        let row = rows.last().expect("non-empty bounded page");
        ReleaseCursor {
            created_at: row.10,
            release_id: row.0,
        }
    });
    let items = rows
        .into_iter()
        .map(release_contract)
        .collect::<Result<Vec<_>, _>>()?;
    Ok((items, next))
}

pub async fn get_release(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    release_id: Uuid,
) -> Result<OwnedRelease, WorkflowError> {
    let mut transaction = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    let package_id =
        sqlx::query_scalar::<_, Uuid>("SELECT package_id FROM releases WHERE id=$1 FOR SHARE")
            .bind(release_id)
            .fetch_optional(&mut *transaction)
            .await
            .map_err(|_| WorkflowError::Database)?
            .ok_or(WorkflowError::NotFound)?;
    lock_package_membership(&mut transaction, principal, package_id).await?;
    let row = sqlx::query_as::<_, ReleaseRow>(
        "SELECT id,package_id,version,status,compatibility,permissions,created_by_issuer, \
         created_by_subject,published_at,yanked_at,created_at,updated_at FROM releases WHERE id=$1",
    )
    .bind(release_id)
    .fetch_one(&mut *transaction)
    .await
    .map_err(|_| WorkflowError::Database)?;
    transaction
        .commit()
        .await
        .map_err(|_| WorkflowError::Database)?;
    release_contract(row)
}

pub async fn get_package(
    repository: &PostgresPublisherRepository,
    principal: &PrincipalRef,
    package_id: Uuid,
) -> Result<OwnedPackage, WorkflowError> {
    let mut transaction = repository
        .pool
        .begin()
        .await
        .map_err(|_| WorkflowError::Database)?;
    lock_package_membership(&mut transaction, principal, package_id).await?;
    let row = sqlx::query_as::<_, PackageRow>(
        "SELECT id,publisher_id,slug::text,kind,status,visibility,name,summary,description,tags,created_at,updated_at \
         FROM packages WHERE id=$1",
    )
    .bind(package_id)
    .fetch_optional(&mut *transaction)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    transaction
        .commit()
        .await
        .map_err(|_| WorkflowError::Database)?;
    package_contract(row)
}

async fn lock_publisher_membership(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    publisher_id: Uuid,
) -> Result<(), WorkflowError> {
    let member = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM publisher_members WHERE publisher_id=$1 AND principal_issuer=$2 \
         AND principal_subject=$3 AND status='active' FOR SHARE",
    )
    .bind(publisher_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| WorkflowError::Database)?;
    member.map(|_| ()).ok_or(WorkflowError::Forbidden)
}

async fn lock_package_membership(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    package_id: Uuid,
) -> Result<(), WorkflowError> {
    let publisher_id =
        sqlx::query_scalar::<_, Uuid>("SELECT publisher_id FROM packages WHERE id=$1 FOR SHARE")
            .bind(package_id)
            .fetch_optional(&mut **transaction)
            .await
            .map_err(|_| WorkflowError::Database)?
            .ok_or(WorkflowError::NotFound)?;
    lock_publisher_membership(transaction, principal, publisher_id).await
}

pub(crate) fn package_contract(row: PackageRow) -> Result<OwnedPackage, WorkflowError> {
    let package = OwnedPackage {
        id: row.0,
        publisher_id: row.1,
        slug: row.2,
        kind: package_kind(&row.3)?,
        status: package_status(&row.4)?,
        visibility: visibility(&row.5)?,
        name: row.6,
        summary: row.7,
        description: row.8,
        tags: row.9,
        created_at: timestamp(row.10)?,
        updated_at: timestamp(row.11)?,
    };
    package
        .validate()
        .then_some(package)
        .ok_or(WorkflowError::Database)
}

fn package_summary_contract(row: PackageSummaryRow) -> Result<OwnedPackageSummary, WorkflowError> {
    let package = OwnedPackageSummary {
        id: row.0,
        publisher_id: row.1,
        slug: row.2,
        kind: package_kind(&row.3)?,
        status: package_status(&row.4)?,
        visibility: visibility(&row.5)?,
        name: row.6,
        summary: row.7,
        tags: row.8,
        created_at: timestamp(row.9)?,
        updated_at: timestamp(row.10)?,
    };
    package
        .validate()
        .then_some(package)
        .ok_or(WorkflowError::Database)
}

pub(crate) fn release_contract(row: ReleaseRow) -> Result<OwnedRelease, WorkflowError> {
    let compatibility = if row.4.as_object().is_some_and(|value| value.is_empty()) {
        PublicCompatibility::default()
    } else {
        serde_json::from_value(row.4).map_err(|_| WorkflowError::Database)?
    };
    let release = OwnedRelease {
        id: row.0,
        package_id: row.1,
        version: row.2,
        status: release_status(&row.3)?,
        compatibility,
        permissions: serde_json::from_value(row.5).map_err(|_| WorkflowError::Database)?,
        created_by: ContractPrincipalRef {
            issuer: row.6,
            subject: row.7,
        },
        published_at: row.8.map(timestamp).transpose()?,
        yanked_at: row.9.map(timestamp).transpose()?,
        created_at: timestamp(row.10)?,
        updated_at: timestamp(row.11)?,
    };
    release
        .validate()
        .then_some(release)
        .ok_or(WorkflowError::Database)
}

fn timestamp(value: OffsetDateTime) -> Result<String, WorkflowError> {
    value.format(&Rfc3339).map_err(|_| WorkflowError::Database)
}

fn publisher_role(value: &str) -> Result<PublisherRole, WorkflowError> {
    match value {
        "owner" => Ok(PublisherRole::Owner),
        "maintainer" => Ok(PublisherRole::Maintainer),
        "release_manager" => Ok(PublisherRole::ReleaseManager),
        _ => Err(WorkflowError::Database),
    }
}

fn publisher_state(value: &str) -> Result<PublisherState, WorkflowError> {
    match value {
        "pending" => Ok(PublisherState::Pending),
        "active" => Ok(PublisherState::Active),
        "suspended" => Ok(PublisherState::Suspended),
        "closed" => Ok(PublisherState::Closed),
        _ => Err(WorkflowError::Database),
    }
}

fn package_kind(value: &str) -> Result<PackageKind, WorkflowError> {
    match value {
        "art" => Ok(PackageKind::Art),
        "capability" => Ok(PackageKind::Capability),
        "app_update" => Ok(PackageKind::AppUpdate),
        _ => Err(WorkflowError::Database),
    }
}

fn package_status(value: &str) -> Result<OwnedPackageStatus, WorkflowError> {
    match value {
        "draft" => Ok(OwnedPackageStatus::Draft),
        "submitted" => Ok(OwnedPackageStatus::Submitted),
        "published" => Ok(OwnedPackageStatus::Published),
        "suspended" => Ok(OwnedPackageStatus::Suspended),
        "deprecated" => Ok(OwnedPackageStatus::Deprecated),
        "archived" => Ok(OwnedPackageStatus::Archived),
        _ => Err(WorkflowError::Database),
    }
}

fn release_status(value: &str) -> Result<OwnedReleaseStatus, WorkflowError> {
    match value {
        "draft" => Ok(OwnedReleaseStatus::Draft),
        "uploading" => Ok(OwnedReleaseStatus::Uploading),
        "submitted" => Ok(OwnedReleaseStatus::Submitted),
        "in_review" => Ok(OwnedReleaseStatus::InReview),
        "approved" => Ok(OwnedReleaseStatus::Approved),
        "published" => Ok(OwnedReleaseStatus::Published),
        "rejected" => Ok(OwnedReleaseStatus::Rejected),
        "yanked" => Ok(OwnedReleaseStatus::Yanked),
        _ => Err(WorkflowError::Database),
    }
}

fn visibility(value: &str) -> Result<PackageVisibility, WorkflowError> {
    match value {
        "public" => Ok(PackageVisibility::Public),
        "unlisted" => Ok(PackageVisibility::Unlisted),
        "private" => Ok(PackageVisibility::Private),
        _ => Err(WorkflowError::Database),
    }
}
