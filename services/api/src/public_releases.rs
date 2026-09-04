use assetlibrary_contracts::{
    DownloadArtifact, PublicCompatibility, PublishedRelease, PublishedReleaseArtifact,
};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgPool;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

#[derive(Debug)]
pub enum PublicReleaseError {
    Database(sqlx::Error),
    InvalidProjection(&'static str),
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct ReleaseCursor {
    #[serde(with = "time::serde::rfc3339")]
    pub published_at: OffsetDateTime,
    pub release_id: Uuid,
}

pub struct ReleaseFilter {
    pub cursor: Option<ReleaseCursor>,
    pub limit: u16,
}

#[async_trait]
pub trait PublicReleaseRepository: Send + Sync {
    async fn list(
        &self,
        package_id: Uuid,
        package_slug: &str,
        filter: &ReleaseFilter,
    ) -> Result<(Vec<PublishedRelease>, Option<ReleaseCursor>), PublicReleaseError>;
}

pub struct PostgresPublicReleaseRepository {
    pool: PgPool,
}

impl PostgresPublicReleaseRepository {
    pub fn new(pool: PgPool) -> Self {
        Self { pool }
    }
}

#[derive(Default)]
pub struct DevelopmentPublicReleaseRepository;

#[async_trait]
impl PublicReleaseRepository for DevelopmentPublicReleaseRepository {
    async fn list(
        &self,
        _package_id: Uuid,
        _package_slug: &str,
        _filter: &ReleaseFilter,
    ) -> Result<(Vec<PublishedRelease>, Option<ReleaseCursor>), PublicReleaseError> {
        Ok((Vec::new(), None))
    }
}

#[async_trait]
impl PublicReleaseRepository for PostgresPublicReleaseRepository {
    async fn list(
        &self,
        package_id: Uuid,
        package_slug: &str,
        filter: &ReleaseFilter,
    ) -> Result<(Vec<PublishedRelease>, Option<ReleaseCursor>), PublicReleaseError> {
        let mut rows = sqlx::query_as::<_, ReleaseRow>(RELEASE_QUERY)
            .bind(package_id)
            .bind(filter.cursor.as_ref().map(|cursor| cursor.published_at))
            .bind(filter.cursor.as_ref().map(|cursor| cursor.release_id))
            .bind(i64::from(filter.limit) + 1)
            .fetch_all(&self.pool)
            .await
            .map_err(PublicReleaseError::Database)?;
        let has_more = rows.len() > usize::from(filter.limit);
        rows.truncate(usize::from(filter.limit));
        let next = has_more.then(|| rows.last().map(row_cursor)).flatten();
        let items = rows
            .into_iter()
            .map(|row| into_contract(row, package_slug))
            .collect::<Result<Vec<_>, _>>()?;
        Ok((items, next))
    }
}

type ReleaseRow = (Uuid, String, OffsetDateTime, Value, Value, Value);

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ArtifactRow {
    artifact_id: Uuid,
    digest: String,
    size_bytes: i64,
    media_type: String,
    signing_key_id: String,
}

fn row_cursor(row: &ReleaseRow) -> ReleaseCursor {
    ReleaseCursor {
        published_at: row.2,
        release_id: row.0,
    }
}

fn into_contract(
    row: ReleaseRow,
    package_slug: &str,
) -> Result<PublishedRelease, PublicReleaseError> {
    let compatibility = if row.3.as_object().is_some_and(|value| value.is_empty()) {
        PublicCompatibility::default()
    } else {
        serde_json::from_value(row.3)
            .map_err(|_| PublicReleaseError::InvalidProjection("invalid compatibility"))?
    };
    let permissions = serde_json::from_value(row.4)
        .map_err(|_| PublicReleaseError::InvalidProjection("invalid permissions"))?;
    let artifacts: Vec<ArtifactRow> = serde_json::from_value(row.5)
        .map_err(|_| PublicReleaseError::InvalidProjection("invalid artifacts"))?;
    let published_at = row
        .2
        .format(&Rfc3339)
        .map_err(|_| PublicReleaseError::InvalidProjection("invalid publication time"))?;
    let file_name = file_name(package_slug, &row.1);
    let release = PublishedRelease {
        id: row.0,
        version: row.1,
        published_at,
        compatibility,
        permissions,
        artifacts: artifacts
            .into_iter()
            .map(|artifact| {
                let size_bytes = u64::try_from(artifact.size_bytes)
                    .map_err(|_| PublicReleaseError::InvalidProjection("invalid artifact size"))?;
                Ok(PublishedReleaseArtifact {
                    artifact: DownloadArtifact {
                        artifact_id: artifact.artifact_id,
                        release_id: row.0,
                        digest: artifact.digest,
                        size_bytes,
                        media_type: artifact.media_type,
                        file_name: file_name.clone(),
                    },
                    signing_key_id: artifact.signing_key_id,
                })
            })
            .collect::<Result<Vec<_>, _>>()?,
    };
    release
        .validate()
        .then_some(release)
        .ok_or(PublicReleaseError::InvalidProjection(
            "invalid public release",
        ))
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

const RELEASE_QUERY: &str = r#"
SELECT r.id release_id,r.version,r.published_at,r.compatibility,r.permissions,projection.artifacts
FROM releases r
JOIN packages p ON p.id=r.package_id
JOIN publishers publisher ON publisher.id=p.publisher_id
JOIN LATERAL (
  SELECT jsonb_agg(jsonb_build_object(
    'artifact_id',eligible.id,'digest',eligible.digest,'size_bytes',eligible.size_bytes,
    'media_type',eligible.media_type,'signing_key_id',eligible.signing_key_id
  ) ORDER BY eligible.id) artifacts
  FROM (
    SELECT a.id,encode(a.canonical_sha256,'hex') digest,a.size_bytes,a.media_type,key.key_id signing_key_id
    FROM published_release_artifacts published
    JOIN artifacts a ON a.release_id=published.release_id AND a.id=published.artifact_id
    JOIN publisher_signing_keys key ON key.publisher_id=p.publisher_id
      AND key.key_id=a.signature->>'keyId' AND key.status='active'
    WHERE published.release_id=r.id AND a.status='verified'
      AND a.canonical_sha256 IS NOT NULL AND a.size_bytes IS NOT NULL AND a.media_type IS NOT NULL
      AND a.published_object_key='sha256/' || left(encode(a.canonical_sha256,'hex'),2) || '/' || encode(a.canonical_sha256,'hex')
      AND NOT EXISTS (SELECT 1 FROM blocklist_entries b WHERE b.status='active' AND
        (b.target_type,b.target_ref) IN (('artifact',a.id::text),('signing_key',p.publisher_id::text || ':' || key.key_id)))
    ORDER BY a.id LIMIT 33
  ) eligible
) projection ON projection.artifacts IS NOT NULL
WHERE p.id=$1 AND p.status='published' AND p.visibility='public' AND publisher.status='active'
  AND r.status='published' AND NOT EXISTS (SELECT 1 FROM blocklist_entries b WHERE b.status='active' AND
    (b.target_type,b.target_ref) IN (('publisher',p.publisher_id::text),('package',p.id::text),('release',r.id::text)))
  AND ($2::timestamptz IS NULL OR r.published_at < $2
    OR (r.published_at = $2 AND r.id > $3))
ORDER BY r.published_at DESC,r.id LIMIT $4
"#;
