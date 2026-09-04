use assetlibrary_contracts::{
    PackageKind, PackageStatus, PublishedPackage, PublisherSummary, SCHEMA_VERSION_V1,
    SearchPackageDocument,
};
use serde_json::Value;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(FromRow)]
struct DocumentRow {
    package_id: Uuid,
    package_slug: String,
    package_name: String,
    package_kind: String,
    package_summary: String,
    package_description: String,
    package_tags: Vec<String>,
    publisher_id: Uuid,
    publisher_slug: String,
    publisher_name: String,
    release_id: Uuid,
    release_version: String,
    artifact_id: Uuid,
    digest: Vec<u8>,
    size_bytes: i64,
    media_type: String,
    object_key: String,
    signing_key_id: String,
    updated_at_seconds: i64,
}

#[derive(Clone, Debug)]
pub struct EdgeState {
    pub public_digest: Option<String>,
    pub public_policy: Option<Value>,
    pub revocation_keys: Vec<String>,
}

#[derive(Clone)]
pub struct Repository {
    pool: PgPool,
}

impl Repository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }

    pub async fn projection_guard(&self) -> Result<Transaction<'_, Postgres>, sqlx::Error> {
        let mut transaction = self.pool.begin().await?;
        sqlx::query("SELECT pg_advisory_xact_lock(715835771309128501::bigint)")
            .execute(&mut *transaction)
            .await?;
        Ok(transaction)
    }

    pub async fn document(
        &self,
        package_id: Uuid,
    ) -> Result<Option<SearchPackageDocument>, sqlx::Error> {
        let row = sqlx::query_as::<_, DocumentRow>(DOCUMENT_QUERY)
            .bind(package_id)
            .fetch_optional(&self.pool)
            .await?;
        row.map(document).transpose().map_err(protocol_error)
    }

    pub async fn package_ids(
        &self,
        after: Option<Uuid>,
        limit: i64,
    ) -> Result<Vec<Uuid>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT id FROM packages WHERE ($1::uuid IS NULL OR id>$1) ORDER BY id LIMIT $2",
        )
        .bind(after)
        .bind(limit.clamp(1, 500))
        .fetch_all(&self.pool)
        .await
    }

    pub async fn was_processed(&self, event_id: Uuid) -> Result<bool, sqlx::Error> {
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM projection_events WHERE projection='search-edge-v1' AND event_id=$1)")
            .bind(event_id).fetch_one(&self.pool).await
    }

    pub async fn mark_processed(
        &self,
        event_id: Uuid,
        package_id: Uuid,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO projection_events(projection,event_id,aggregate_id) VALUES ('search-edge-v1',$1,$2) ON CONFLICT DO NOTHING")
            .bind(event_id).bind(package_id).execute(&self.pool).await.map(|_| ())
    }

    pub async fn active_revocations(&self, package_id: Uuid) -> Result<Vec<String>, sqlx::Error> {
        sqlx::query_scalar(
            "SELECT 'revoked:' || b.target_type || ':' || b.target_ref FROM blocklist_entries b \
             JOIN packages p ON p.id=$1 WHERE b.status='active' AND ( \
             (b.target_type='publisher' AND b.target_ref=p.publisher_id::text) OR \
             (b.target_type='package' AND b.target_ref=p.id::text) OR \
             (b.target_type='release' AND b.target_ref IN (SELECT id::text FROM releases WHERE package_id=p.id)) OR \
             (b.target_type='artifact' AND b.target_ref IN (SELECT a.id::text FROM artifacts a JOIN releases r ON r.id=a.release_id WHERE r.package_id=p.id)) OR \
             (b.target_type='signing_key' AND b.target_ref LIKE p.publisher_id::text || ':%')) \
             ORDER BY 1",
        )
        .bind(package_id)
        .fetch_all(&self.pool)
        .await
    }

    pub async fn edge_state(&self, package_id: Uuid) -> Result<EdgeState, sqlx::Error> {
        let row = sqlx::query_as::<_, (Option<String>, Option<Value>, Vec<String>)>(
            "SELECT public_digest,public_policy,revocation_keys FROM edge_policy_projections WHERE package_id=$1",
        )
        .bind(package_id)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map_or(
            EdgeState {
                public_digest: None,
                public_policy: None,
                revocation_keys: Vec::new(),
            },
            |value| EdgeState {
                public_digest: value.0,
                public_policy: value.1,
                revocation_keys: value.2,
            },
        ))
    }

    pub async fn save_edge_state(
        &self,
        package_id: Uuid,
        public_digest: Option<&str>,
        public_policy: Option<&Value>,
        revocation_keys: &[String],
    ) -> Result<(), sqlx::Error> {
        sqlx::query(
            "INSERT INTO edge_policy_projections(package_id,public_digest,public_policy,revocation_keys) \
             VALUES($1,$2,$3,$4) ON CONFLICT(package_id) DO UPDATE SET public_digest=EXCLUDED.public_digest, \
             public_policy=EXCLUDED.public_policy,revocation_keys=EXCLUDED.revocation_keys",
        )
        .bind(package_id)
        .bind(public_digest)
        .bind(public_policy)
        .bind(revocation_keys)
        .execute(&self.pool)
        .await
        .map(|_| ())
    }

    pub async fn set_active_index(&self, projection: &str, index: &str) -> Result<(), sqlx::Error> {
        sqlx::query("INSERT INTO search_projection_state(projection,active_index) VALUES ($1,$2) \
            ON CONFLICT(projection) DO UPDATE SET active_index=EXCLUDED.active_index,rebuilt_at=now()")
            .bind(projection).bind(index).execute(&self.pool).await.map(|_| ())
    }
}

const DOCUMENT_QUERY: &str = r#"
SELECT p.id package_id,p.slug::text package_slug,p.name package_name,p.kind package_kind,
       p.summary package_summary,p.description package_description,p.tags package_tags,
       publisher.id publisher_id,publisher.slug::text publisher_slug,publisher.display_name publisher_name,
       latest.release_id,latest.release_version,latest.artifact_id,latest.digest,latest.size_bytes,
       latest.media_type,latest.object_key,latest.signing_key_id,
       extract(epoch FROM greatest(p.updated_at,latest.release_updated_at,latest.artifact_updated_at))::bigint updated_at_seconds
FROM packages p
JOIN publishers publisher ON publisher.id=p.publisher_id AND publisher.status='active'
JOIN LATERAL (
    SELECT r.id release_id,r.version release_version,a.id artifact_id,a.canonical_sha256 digest,
           a.size_bytes,a.media_type,a.published_object_key object_key,key.key_id signing_key_id,
           r.updated_at release_updated_at,a.updated_at artifact_updated_at
    FROM releases r
    JOIN published_release_artifacts published ON published.release_id=r.id
    JOIN artifacts a ON a.release_id=r.id AND a.id=published.artifact_id
    JOIN publisher_signing_keys key ON key.publisher_id=p.publisher_id
      AND key.key_id=a.signature->>'keyId' AND key.status='active'
    WHERE r.package_id=p.id AND r.status='published' AND a.status='verified'
      AND a.canonical_sha256 IS NOT NULL AND a.size_bytes IS NOT NULL
      AND a.media_type IS NOT NULL AND a.published_object_key IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM blocklist_entries b WHERE b.status='active' AND
        (b.target_type,b.target_ref) IN (('release',r.id::text),('artifact',a.id::text),
        ('signing_key',p.publisher_id::text || ':' || key.key_id)))
    ORDER BY r.published_at DESC,r.id DESC,a.id DESC LIMIT 1
) latest ON true
WHERE p.id=$1 AND p.status='published' AND p.visibility='public'
  AND NOT EXISTS (SELECT 1 FROM blocklist_entries b WHERE b.status='active' AND
    (b.target_type,b.target_ref) IN (('publisher',p.publisher_id::text),('package',p.id::text)))
"#;

fn document(row: DocumentRow) -> Result<SearchPackageDocument, &'static str> {
    let kind = match row.package_kind.as_str() {
        "art" => PackageKind::Art,
        "capability" => PackageKind::Capability,
        "app_update" => PackageKind::AppUpdate,
        _ => return Err("unknown package kind"),
    };
    let digest = hex::encode(&row.digest);
    let expected_key = format!("sha256/{}/{digest}", &digest[..2]);
    if row.digest.len() != 32 || row.object_key != expected_key {
        return Err("noncanonical published object");
    }
    let updated_at = OffsetDateTime::from_unix_timestamp(row.updated_at_seconds)
        .map_err(|_| "invalid update time")?
        .format(&Rfc3339)
        .map_err(|_| "invalid update time")?;
    let document = SearchPackageDocument {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        package: PublishedPackage {
            id: row.package_id,
            slug: row.package_slug.clone(),
            name: row.package_name,
            kind,
            publisher: PublisherSummary {
                id: row.publisher_id,
                slug: row.publisher_slug,
                display_name: row.publisher_name,
            },
            status: PackageStatus::Published,
            summary: row.package_summary,
        },
        description: row.package_description,
        tags: row.package_tags,
        release_id: row.release_id,
        version: row.release_version.clone(),
        artifact_id: row.artifact_id,
        signing_key_id: row.signing_key_id,
        digest,
        size_bytes: u64::try_from(row.size_bytes).map_err(|_| "invalid artifact size")?,
        media_type: row.media_type,
        file_name: file_name(&row.package_slug, &row.release_version),
        updated_at,
    };
    document
        .validate()
        .then_some(document)
        .ok_or("invalid search document")
}

fn file_name(slug: &str, version: &str) -> String {
    let version = version
        .chars()
        .map(|value| {
            if value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-') {
                value
            } else {
                '-'
            }
        })
        .collect::<String>();
    format!("{slug}-{version}.zip").chars().take(180).collect()
}

fn protocol_error(message: &'static str) -> sqlx::Error {
    sqlx::Error::Protocol(message.to_owned())
}
