use sqlx::{Postgres, Transaction};
use uuid::Uuid;

use crate::{identity::PrincipalRef, workflow::WorkflowError};

#[cfg(test)]
#[path = "publisher_key_invalidation_tests.rs"]
mod tests;

// The key row is already locked by revoke. Publication takes a conflicting key
// lock, so it cannot commit a new binding behind this invalidation snapshot.
// Insert on the server rather than loading a publisher's package list into RAM.
pub async fn emit_revocation(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    publisher_id: Uuid,
    key_id: &str,
) -> Result<(), WorkflowError> {
    let previous: String = sqlx::query_scalar("SELECT current_setting('statement_timeout')")
        .fetch_one(&mut **tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    sqlx::query(
        "SELECT set_config('statement_timeout',CASE \
        WHEN current_setting('statement_timeout')::interval=interval '0' \
          OR current_setting('statement_timeout')::interval>interval '5s' \
        THEN '5s' ELSE current_setting('statement_timeout') END,true)",
    )
    .execute(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    sqlx::query(INSERT_INVALIDATIONS)
        .bind(publisher_id)
        .bind(key_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .execute(&mut **tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    sqlx::query("SELECT set_config('statement_timeout',$1,true)")
        .bind(previous)
        .execute(&mut **tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
    Ok(())
}

const INSERT_INVALIDATIONS: &str = r#"
INSERT INTO outbox_events(id,subject,schema_version,aggregate_type,aggregate_id,payload)
SELECT event.id,'assetlibrary.catalog.invalidated.v1','1.0','package',event.package_id,
       jsonb_build_object('event_id',event.id,'occurred_at',now(),'schema_version','1.0',
         'actor',jsonb_build_object('type','principal','issuer',$3::text,'subject',$4::text),
         'package_id',event.package_id,'reason','signing_key_revoked')
FROM (
    SELECT gen_random_uuid() id,p.id package_id FROM packages p
    WHERE p.publisher_id=$1 AND EXISTS (
        SELECT 1 FROM releases r JOIN artifacts a ON a.release_id=r.id
        WHERE r.package_id=p.id AND a.signature->>'keyId'=$2
    )
) event
"#;
