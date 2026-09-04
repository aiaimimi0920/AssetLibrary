use assetlibrary_contracts::{
    CreateDownloadSessionRequest, DownloadArtifact, DownloadClientType, DownloadSession,
    PublicDownload, SCHEMA_VERSION_V1,
};
use async_trait::async_trait;
use serde_json::json;
use sqlx::{PgPool, Postgres, Transaction};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{
    config::DownloadConfig,
    identity::PrincipalRef,
    workflow::{WorkflowError, idempotency, publication::emit},
};

use super::ticket::{TicketClaims, TicketSigner};

#[derive(Clone)]
pub struct PostgresDownloadRepository {
    pool: PgPool,
    config: DownloadConfig,
    signer: TicketSigner,
}

impl PostgresDownloadRepository {
    pub fn new(pool: PgPool, config: DownloadConfig) -> Result<Self, &'static str> {
        let signer = TicketSigner::new(config.ticket_secret.clone())?;
        Ok(Self {
            pool,
            config,
            signer,
        })
    }
}

#[derive(Default)]
pub struct UnavailableDownloadRepository;

#[async_trait]
pub trait DownloadRepository: Send + Sync {
    async fn public_download(&self, artifact_id: Uuid) -> Result<PublicDownload, WorkflowError>;
    async fn issue(
        &self,
        principal: &PrincipalRef,
        artifact_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateDownloadSessionRequest,
    ) -> Result<DownloadSession, WorkflowError>;
}

type AccessRow = (
    Uuid,
    Uuid,
    Uuid,
    Uuid,
    String,
    String,
    String,
    Vec<u8>,
    i64,
    String,
    String,
    String,
    String,
);

struct Access {
    artifact_id: Uuid,
    release_id: Uuid,
    package_id: Uuid,
    publisher_id: Uuid,
    kind: String,
    visibility: String,
    object_key: String,
    digest: String,
    size_bytes: u64,
    media_type: String,
    slug: String,
    version: String,
    signing_key_id: String,
}

const ACCESS_QUERY: &str = r#"
SELECT a.id,r.id,p.id,p.publisher_id,p.kind,p.visibility,a.published_object_key,
       a.canonical_sha256,a.size_bytes,a.media_type,p.slug::text,r.version,signing_key.key_id
FROM artifacts a
JOIN releases r ON r.id=a.release_id
JOIN published_release_artifacts published ON published.release_id=r.id AND published.artifact_id=a.id
JOIN packages p ON p.id=r.package_id
JOIN publishers publisher ON publisher.id=p.publisher_id
JOIN publisher_signing_keys signing_key ON signing_key.publisher_id=p.publisher_id
    AND signing_key.key_id=a.signature->>'keyId' AND signing_key.status='active'
WHERE a.id=$1 AND a.status='verified' AND r.status='published'
  AND p.status='published' AND publisher.status='active'
  AND a.published_object_key IS NOT NULL AND a.canonical_sha256 IS NOT NULL
  AND a.size_bytes IS NOT NULL AND a.media_type IS NOT NULL
  AND NOT EXISTS (
      SELECT 1 FROM blocklist_entries b WHERE b.status='active'
        AND (b.target_type,b.target_ref) IN (
            ('publisher',p.publisher_id::text),('package',p.id::text),
            ('release',r.id::text),('artifact',a.id::text),
            ('signing_key',p.publisher_id::text || ':' || signing_key.key_id)
        )
  )
"#;

#[async_trait]
impl DownloadRepository for PostgresDownloadRepository {
    async fn public_download(&self, artifact_id: Uuid) -> Result<PublicDownload, WorkflowError> {
        let access = access(
            sqlx::query_as::<_, AccessRow>(ACCESS_QUERY)
                .bind(artifact_id)
                .fetch_optional(&self.pool)
                .await
                .map_err(|_| WorkflowError::Database)?
                .ok_or(WorkflowError::NotFound)?,
        )?;
        if access.kind != "art" || access.visibility != "public" {
            return Err(WorkflowError::NotFound);
        }
        Ok(PublicDownload {
            schema_version: SCHEMA_VERSION_V1.to_owned(),
            download_url: self.public_url(&access),
            artifact: access.artifact(),
        })
    }

    async fn issue(
        &self,
        principal: &PrincipalRef,
        artifact_id: Uuid,
        key: &str,
        request_id: &str,
        request: &CreateDownloadSessionRequest,
    ) -> Result<DownloadSession, WorkflowError> {
        let operation = "download.issue";
        let request_digest =
            idempotency::request_digest(operation, &artifact_id.to_string(), request);
        let mut tx = self
            .pool
            .begin()
            .await
            .map_err(|_| WorkflowError::Database)?;
        lock_idempotency(&mut tx, principal, key).await?;
        let access = load_access(&mut tx, artifact_id).await?;
        if access.visibility == "private"
            && !is_member(&mut tx, principal, access.package_id).await?
        {
            return Err(WorkflowError::NotFound);
        }
        if let Some(existing) = load_existing(&mut tx, principal, key).await? {
            if existing.request_digest != request_digest {
                return Err(WorkflowError::IdempotencyConflict);
            }
            if existing.artifact_id != artifact_id || existing.status != "issued" {
                return Err(WorkflowError::InvalidState);
            }
            return self.replay(existing, access);
        }
        let issued_at =
            OffsetDateTime::from_unix_timestamp(OffsetDateTime::now_utc().unix_timestamp())
                .map_err(|_| WorkflowError::Database)?;
        let expires_at = issued_at + Duration::seconds(i64::from(self.config.ticket_ttl_seconds));
        let session_id = Uuid::new_v4();
        let nonce = Uuid::new_v4();
        let claims = self.claims(
            &access,
            session_id,
            nonce,
            request.client_type,
            issued_at,
            expires_at,
        );
        let (token, ticket_hash) = self
            .signer
            .issue(&claims)
            .map_err(|_| WorkflowError::Database)?;
        sqlx::query(
            "INSERT INTO download_sessions (id,principal_issuer,principal_subject,artifact_id,status, \
             ticket_hash,expires_at,package_id,release_id,publisher_id,object_key,digest,nonce,audience, \
             purpose,client_type,idempotency_key,request_digest,issued_at) VALUES \
             ($1,$2,$3,$4,'issued',$5,$6,$7,$8,$9,$10,$11,$12,$13,'download',$14,$15,$16,$17)",
        )
        .bind(session_id)
        .bind(&principal.issuer)
        .bind(&principal.subject)
        .bind(artifact_id)
        .bind(&ticket_hash)
        .bind(expires_at)
        .bind(access.package_id)
        .bind(access.release_id)
        .bind(access.publisher_id)
        .bind(&access.object_key)
        .bind(hex::decode(&access.digest).map_err(|_| WorkflowError::Database)?)
        .bind(nonce)
        .bind(&self.config.ticket_audience)
        .bind(client_text(request.client_type))
        .bind(key)
        .bind(&request_digest)
        .bind(issued_at)
        .execute(&mut *tx)
        .await
        .map_err(|_| WorkflowError::Database)?;
        record_issue(
            &mut tx,
            principal,
            request_id,
            &access,
            session_id,
            request.client_type,
        )
        .await?;
        tx.commit().await.map_err(|_| WorkflowError::Database)?;
        self.response(access, session_id, token, expires_at)
    }
}

impl PostgresDownloadRepository {
    fn public_url(&self, access: &Access) -> String {
        format!(
            "{}/public/sha256/{}/{}",
            self.config.public_base_url,
            access.digest,
            access.file_name()
        )
    }

    fn restricted_path(&self, access: &Access) -> String {
        format!(
            "/restricted/sha256/{}/{}",
            access.digest,
            access.file_name()
        )
    }

    fn claims(
        &self,
        access: &Access,
        session_id: Uuid,
        nonce: Uuid,
        client_type: DownloadClientType,
        issued_at: OffsetDateTime,
        expires_at: OffsetDateTime,
    ) -> TicketClaims {
        TicketClaims {
            issuer: self.config.ticket_issuer.clone(),
            audience: self.config.ticket_audience.clone(),
            purpose: "download".to_owned(),
            session_id,
            publisher_id: access.publisher_id,
            package_id: access.package_id,
            release_id: access.release_id,
            artifact_id: access.artifact_id,
            signing_key_id: access.signing_key_id.clone(),
            client_type,
            digest: access.digest.clone(),
            object_key: access.object_key.clone(),
            path: self.restricted_path(access),
            nonce,
            issued_at: issued_at.unix_timestamp(),
            not_before: issued_at.unix_timestamp() - 5,
            expires_at: expires_at.unix_timestamp(),
        }
    }

    fn response(
        &self,
        access: Access,
        session_id: Uuid,
        token: String,
        expires_at: OffsetDateTime,
    ) -> Result<DownloadSession, WorkflowError> {
        Ok(DownloadSession {
            schema_version: SCHEMA_VERSION_V1.to_owned(),
            session_id,
            download_url: format!(
                "{}{}",
                self.config.restricted_base_url,
                self.restricted_path(&access)
            ),
            artifact: access.artifact(),
            access_token: token,
            expires_at: expires_at
                .format(&Rfc3339)
                .map_err(|_| WorkflowError::Database)?,
        })
    }

    fn replay(
        &self,
        existing: ExistingSession,
        access: Access,
    ) -> Result<DownloadSession, WorkflowError> {
        let now = OffsetDateTime::now_utc();
        if existing.expires_at <= now || existing.object_key != access.object_key {
            return Err(WorkflowError::InvalidState);
        }
        let claims = self.claims(
            &access,
            existing.id,
            existing.nonce,
            existing.client_type,
            existing.issued_at,
            existing.expires_at,
        );
        let (token, hash) = self
            .signer
            .issue(&claims)
            .map_err(|_| WorkflowError::Database)?;
        if hash != existing.ticket_hash {
            return Err(WorkflowError::InvalidState);
        }
        self.response(access, existing.id, token, existing.expires_at)
    }
}

struct ExistingSession {
    id: Uuid,
    artifact_id: Uuid,
    status: String,
    ticket_hash: Vec<u8>,
    nonce: Uuid,
    object_key: String,
    request_digest: Vec<u8>,
    client_type: DownloadClientType,
    issued_at: OffsetDateTime,
    expires_at: OffsetDateTime,
}

type ExistingRow = (
    Uuid,
    Uuid,
    String,
    Vec<u8>,
    Uuid,
    String,
    Vec<u8>,
    String,
    i64,
    i64,
);

async fn load_existing(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    key: &str,
) -> Result<Option<ExistingSession>, WorkflowError> {
    let row = sqlx::query_as::<_, ExistingRow>(
        "SELECT id,artifact_id,status,ticket_hash,nonce,object_key,request_digest,client_type, \
         extract(epoch FROM issued_at)::bigint,extract(epoch FROM expires_at)::bigint \
         FROM download_sessions WHERE principal_issuer=$1 AND principal_subject=$2 \
         AND idempotency_key=$3 FOR UPDATE",
    )
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .bind(key)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?;
    row.map(|row| {
        Ok(ExistingSession {
            id: row.0,
            artifact_id: row.1,
            status: row.2,
            ticket_hash: row.3,
            nonce: row.4,
            object_key: row.5,
            request_digest: row.6,
            client_type: parse_client(&row.7).ok_or(WorkflowError::Database)?,
            issued_at: OffsetDateTime::from_unix_timestamp(row.8)
                .map_err(|_| WorkflowError::Database)?,
            expires_at: OffsetDateTime::from_unix_timestamp(row.9)
                .map_err(|_| WorkflowError::Database)?,
        })
    })
    .transpose()
}

async fn lock_idempotency(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    key: &str,
) -> Result<(), WorkflowError> {
    let lock = format!(
        "{}:{}:download.issue:{key}",
        principal.issuer, principal.subject
    );
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))")
        .bind(lock)
        .execute(&mut **tx)
        .await
        .map(|_| ())
        .map_err(|_| WorkflowError::Database)
}

async fn load_access(
    tx: &mut Transaction<'_, Postgres>,
    artifact_id: Uuid,
) -> Result<Access, WorkflowError> {
    access(
        sqlx::query_as::<_, AccessRow>(ACCESS_QUERY)
            .bind(artifact_id)
            .fetch_optional(&mut **tx)
            .await
            .map_err(|_| WorkflowError::Database)?
            .ok_or(WorkflowError::NotFound)?,
    )
}

async fn is_member(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    package_id: Uuid,
) -> Result<bool, WorkflowError> {
    sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM packages p JOIN publisher_members pm ON pm.publisher_id=p.publisher_id \
        WHERE p.id=$1 AND pm.principal_issuer=$2 AND pm.principal_subject=$3 AND pm.status='active')")
        .bind(package_id).bind(&principal.issuer).bind(&principal.subject).fetch_one(&mut **tx).await
        .map_err(|_| WorkflowError::Database)
}

async fn record_issue(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    request_id: &str,
    access: &Access,
    session_id: Uuid,
    client: DownloadClientType,
) -> Result<(), WorkflowError> {
    sqlx::query("INSERT INTO audit_events (actor_issuer,actor_subject,action,resource_type,resource_id,correlation_id,details) \
        VALUES ($1,$2,'download.ticket_issued','download_session',$3,$4,$5)")
        .bind(&principal.issuer).bind(&principal.subject).bind(session_id).bind(request_id)
        .bind(json!({"artifact_id": access.artifact_id, "client_type": client_text(client)}))
        .execute(&mut **tx).await.map_err(|_| WorkflowError::Database)?;
    emit(tx,"assetlibrary.download.authorized.v1","download_session",session_id,
        json!({"session_id":session_id,"package_id":access.package_id,"release_id":access.release_id,
        "artifact_id":access.artifact_id,"digest":format!("sha256:{}",access.digest),"client_type":client_text(client)})).await?;
    Ok(())
}

fn access(row: AccessRow) -> Result<Access, WorkflowError> {
    let digest = hex::encode(&row.7);
    let size_bytes = u64::try_from(row.8).map_err(|_| WorkflowError::Database)?;
    let expected_key = format!("sha256/{}/{digest}", &digest[..2]);
    if row.7.len() != 32 || row.6 != expected_key || size_bytes == 0 || row.9.is_empty() {
        return Err(WorkflowError::InvalidState);
    }
    Ok(Access {
        artifact_id: row.0,
        release_id: row.1,
        package_id: row.2,
        publisher_id: row.3,
        kind: row.4,
        visibility: row.5,
        object_key: row.6,
        digest,
        size_bytes,
        media_type: row.9,
        slug: row.10,
        version: row.11,
        signing_key_id: row.12,
    })
}

impl Access {
    fn file_name(&self) -> String {
        let version = self
            .version
            .chars()
            .map(|value| {
                if value.is_ascii_alphanumeric() || matches!(value, '.' | '_' | '-') {
                    value
                } else {
                    '-'
                }
            })
            .collect::<String>();
        format!("{}-{}.zip", self.slug, version)
            .chars()
            .take(180)
            .collect()
    }
    fn artifact(&self) -> DownloadArtifact {
        DownloadArtifact {
            artifact_id: self.artifact_id,
            release_id: self.release_id,
            digest: self.digest.clone(),
            size_bytes: self.size_bytes,
            media_type: self.media_type.clone(),
            file_name: self.file_name(),
        }
    }
}

fn client_text(client: DownloadClientType) -> &'static str {
    match client {
        DownloadClientType::Web => "web",
        DownloadClientType::Loom => "loom",
        DownloadClientType::Hook => "hook",
        DownloadClientType::Cli => "cli",
    }
}

fn parse_client(value: &str) -> Option<DownloadClientType> {
    match value {
        "web" => Some(DownloadClientType::Web),
        "loom" => Some(DownloadClientType::Loom),
        "hook" => Some(DownloadClientType::Hook),
        "cli" => Some(DownloadClientType::Cli),
        _ => None,
    }
}

#[async_trait]
impl DownloadRepository for UnavailableDownloadRepository {
    async fn public_download(&self, _: Uuid) -> Result<PublicDownload, WorkflowError> {
        Err(WorkflowError::Database)
    }
    async fn issue(
        &self,
        _: &PrincipalRef,
        _: Uuid,
        _: &str,
        _: &str,
        _: &CreateDownloadSessionRequest,
    ) -> Result<DownloadSession, WorkflowError> {
        Err(WorkflowError::Database)
    }
}
