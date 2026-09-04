use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use super::{ArtifactContext, RULE_VERSION, Repository, SCANNER_VERSION, VerifiedRecord};
use crate::event::VerificationRequested;

impl Repository {
    pub async fn mark_quarantined(
        &self,
        context: &ArtifactContext,
        source_event_id: Uuid,
        delivery: i64,
        failure_code: &str,
    ) -> Result<(), sqlx::Error> {
        self.finish_quarantine(context, source_event_id, delivery, failure_code, None)
            .await
    }

    pub async fn mark_retry_exhausted(
        &self,
        context: &ArtifactContext,
        event: &VerificationRequested,
        delivery: i64,
        last_failure_code: &str,
    ) -> Result<(), sqlx::Error> {
        self.finish_quarantine(
            context,
            event.event_id,
            delivery,
            "scan_retry_exhausted",
            Some((event, last_failure_code)),
        )
        .await
    }

    async fn finish_quarantine(
        &self,
        context: &ArtifactContext,
        source_event_id: Uuid,
        delivery: i64,
        failure_code: &str,
        dead_letter: Option<(&VerificationRequested, &str)>,
    ) -> Result<(), sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let status: String =
            sqlx::query_scalar("SELECT status FROM artifacts WHERE id=$1 FOR UPDATE")
                .bind(context.artifact_id)
                .fetch_one(&mut *transaction)
                .await?;
        if matches!(status.as_str(), "verified" | "quarantined" | "deleted") {
            transaction.commit().await?;
            return Ok(());
        }
        let evidence = json!({
            "failure_code": failure_code,
            "last_failure_code": dead_letter.map(|(_, code)| code),
            "source_event_id": source_event_id,
        });
        sqlx::query(
            "UPDATE artifacts SET status='quarantined', verified_at=NULL, last_scan_error=$2, \
                    scanner_version=$3, rule_version=$4, scan_evidence=$5 WHERE id=$1",
        )
        .bind(context.artifact_id)
        .bind(failure_code)
        .bind(SCANNER_VERSION)
        .bind(RULE_VERSION)
        .bind(&evidence)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE upload_sessions SET status='quarantined' WHERE artifact_id=$1")
            .bind(context.artifact_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "UPDATE artifact_scan_attempts SET result='quarantined', failure_code=$3, evidence=$4 \
             WHERE event_id=$1 AND delivery_count=$2",
        )
        .bind(source_event_id)
        .bind(i32::try_from(delivery).unwrap_or(20).clamp(1, 20))
        .bind(failure_code)
        .bind(&evidence)
        .execute(&mut *transaction)
        .await?;
        self.insert_audit(
            &mut transaction,
            context,
            source_event_id,
            "artifact.scan_quarantined",
            &evidence,
        )
        .await?;
        self.insert_terminal_event(
            &mut transaction,
            context,
            "assetlibrary.artifact.quarantined.v1",
            source_event_id,
            Some(failure_code),
        )
        .await?;
        if let Some((event, last_failure_code)) = dead_letter {
            self.insert_dead_letter(
                &mut transaction,
                context,
                event,
                delivery,
                last_failure_code,
            )
            .await?;
        }
        transaction.commit().await
    }

    pub async fn mark_verified(
        &self,
        context: &ArtifactContext,
        source_event_id: Uuid,
        delivery: i64,
        record: VerifiedRecord,
    ) -> Result<(), sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        let row = sqlx::query("SELECT status, object_key FROM artifacts WHERE id=$1 FOR UPDATE")
            .bind(context.artifact_id)
            .fetch_one(&mut *transaction)
            .await?;
        let status: String = row.try_get(0)?;
        if status == "verified" {
            transaction.commit().await?;
            return Ok(());
        }
        if !matches!(status.as_str(), "uploaded" | "scanning")
            || row.try_get::<String, _>(1)? != context.object_key
        {
            return Err(sqlx::Error::Protocol(
                "artifact changed during scanning".to_owned(),
            ));
        }
        let evidence = json!({
            "source_event_id": source_event_id,
            "scanner_version": SCANNER_VERSION,
            "rule_version": RULE_VERSION,
        });
        sqlx::query(
            "UPDATE artifacts SET status='verified', sha256=$2, canonical_sha256=$3, \
                    published_object_key=$4, manifest=$5, signature=$6, sbom_digest=$7, \
                    provenance_digest=$8, verified_at=now(), last_scan_error=NULL, \
                    scanner_version=$9, rule_version=$10, scan_evidence=$11 WHERE id=$1",
        )
        .bind(context.artifact_id)
        .bind(record.raw_sha256.as_slice())
        .bind(record.canonical_sha256.as_slice())
        .bind(&record.published_object_key)
        .bind(&record.manifest)
        .bind(&record.signature)
        .bind(record.sbom_digest.as_slice())
        .bind(record.provenance_digest.as_slice())
        .bind(SCANNER_VERSION)
        .bind(RULE_VERSION)
        .bind(&evidence)
        .execute(&mut *transaction)
        .await?;
        sqlx::query("UPDATE upload_sessions SET status='verified' WHERE artifact_id=$1")
            .bind(context.artifact_id)
            .execute(&mut *transaction)
            .await?;
        sqlx::query(
            "UPDATE artifact_scan_attempts SET result='verified', failure_code=NULL, evidence=$3 \
             WHERE event_id=$1 AND delivery_count=$2",
        )
        .bind(source_event_id)
        .bind(i32::try_from(delivery).unwrap_or(20).clamp(1, 20))
        .bind(&evidence)
        .execute(&mut *transaction)
        .await?;
        self.insert_audit(
            &mut transaction,
            context,
            source_event_id,
            "artifact.scan_verified",
            &evidence,
        )
        .await?;
        self.insert_terminal_event(
            &mut transaction,
            context,
            "assetlibrary.artifact.verified.v1",
            source_event_id,
            None,
        )
        .await?;
        transaction.commit().await
    }

    async fn insert_audit(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        context: &ArtifactContext,
        source_event_id: Uuid,
        action: &str,
        evidence: &serde_json::Value,
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO audit_events \
             (actor_issuer,actor_subject,action,resource_type,resource_id,correlation_id,details) \
             VALUES (NULL,'assetlibrary-scanner',$1,'artifact',$2,$3,$4)",
        )
        .bind(action)
        .bind(context.artifact_id)
        .bind(source_event_id.to_string())
        .bind(evidence)
        .execute(&mut **transaction)
        .await?;
        Ok(())
    }

    async fn insert_terminal_event(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        context: &ArtifactContext,
        subject: &str,
        source_event_id: Uuid,
        failure_code: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        let event_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO outbox_events \
             (id,subject,schema_version,aggregate_type,aggregate_id,payload) \
             VALUES ($1,$2,'1.0','artifact',$3,jsonb_build_object( \
                'event_id',$1,'occurred_at',now(),'schema_version','1.0', \
                'actor',jsonb_build_object('type','system','id','assetlibrary-scanner'), \
                'artifact_id',$3,'release_id',$4,'package_id',$5, \
                'source_event_id',$6,'failure_code',$7))",
        )
        .bind(event_id)
        .bind(subject)
        .bind(context.artifact_id)
        .bind(context.release_id)
        .bind(context.package_id)
        .bind(source_event_id)
        .bind(failure_code)
        .execute(&mut **transaction)
        .await?;
        Ok(())
    }

    async fn insert_dead_letter(
        &self,
        transaction: &mut sqlx::Transaction<'_, sqlx::Postgres>,
        context: &ArtifactContext,
        event: &VerificationRequested,
        delivery: i64,
        failure_code: &str,
    ) -> Result<(), sqlx::Error> {
        let event_id = Uuid::new_v4();
        sqlx::query(
            "INSERT INTO outbox_events \
             (id,subject,schema_version,aggregate_type,aggregate_id,payload) \
             VALUES ($1,'assetlibrary.artifact.verification_dead_letter.v1','1.0','artifact',$2, \
             jsonb_build_object('event_id',$1,'occurred_at',now(),'schema_version','1.0', \
                'actor',jsonb_build_object('type','system','id','assetlibrary-scanner'), \
                'package_id',$3,'release_id',$4,'artifact_id',$2,'source_event_id',$5, \
                'object_key',$6,'digest',$7,'failure_code',$8,'delivery_count',$9))",
        )
        .bind(event_id)
        .bind(context.artifact_id)
        .bind(context.package_id)
        .bind(context.release_id)
        .bind(event.event_id)
        .bind(&context.object_key)
        .bind(&event.digest)
        .bind(failure_code)
        .bind(i32::try_from(delivery).unwrap_or(i32::MAX))
        .execute(&mut **transaction)
        .await?;
        Ok(())
    }
}
