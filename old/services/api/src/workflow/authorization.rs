use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::identity::PrincipalRef;

use super::WorkflowError;

pub async fn require_store_role(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    roles: &[&str],
) -> Result<(), WorkflowError> {
    let authorized = sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM store_roles WHERE principal_issuer=$1 AND principal_subject=$2 \
         AND status='active' AND role=ANY($3) ORDER BY role LIMIT 1 FOR SHARE",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(roles)
    .fetch_optional(&mut **transaction)
    .await
    .map_err(|_| WorkflowError::Database)?;
    if authorized.is_some() {
        Ok(())
    } else {
        Err(WorkflowError::Forbidden)
    }
}

pub async fn is_package_member(
    transaction: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    package_id: Uuid,
) -> Result<bool, WorkflowError> {
    sqlx::query_scalar::<_, i32>(
        "SELECT 1 FROM packages p JOIN publisher_members pm ON pm.publisher_id=p.publisher_id \
         WHERE p.id=$1 AND pm.principal_issuer=$2 AND pm.principal_subject=$3 \
         AND pm.status='active' FOR SHARE OF pm",
    )
    .bind(package_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut **transaction)
    .await
    .map(|value| value.is_some())
    .map_err(|_| WorkflowError::Database)
}
