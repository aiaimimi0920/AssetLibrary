use assetlibrary_contracts::{
    DownloadArtifact, HostProduct, InstallChallenge, InstallHostProfile, InstallPackage,
    PackageKind, PublicCompatibility, SCHEMA_VERSION_V1, SigningKeyAlgorithm, TrustedPublisherKey,
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use semver::{Version, VersionReq};
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::{Postgres, Row, Transaction, postgres::PgRow};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

use crate::{identity::PrincipalRef, workflow::WorkflowError};

pub(super) struct InstallAccess {
    pub download_session_id: Uuid,
    pub artifact_id: Uuid,
    pub release_id: Uuid,
    pub package_id: Uuid,
    publisher_id: Uuid,
    publisher_slug: String,
    package_slug: String,
    kind: PackageKind,
    version: String,
    pub compatibility: PublicCompatibility,
    permissions: Vec<String>,
    pub canonical_digest: String,
    pub archive_digest: String,
    size_bytes: u64,
    media_type: String,
    signing_key_id: String,
    signing_public_key: [u8; 32],
}

pub(super) struct Proof {
    pub access: InstallAccess,
    pub receipt_id: Uuid,
    pub client_instance_id: Uuid,
    pub receipt_public_key: [u8; 32],
    pub nonce: Uuid,
    pub host_profile_digest: String,
    pub issued_at: OffsetDateTime,
    pub expires_at: OffsetDateTime,
    pub status: String,
}

pub(super) async fn load_download_access(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    session_id: Uuid,
) -> Result<InstallAccess, WorkflowError> {
    let row = sqlx::query(&format!(
        "{} AND ds.id=$1 AND ds.principal_issuer=$2 AND ds.principal_subject=$3 \
         AND ds.status='issued' AND ds.expires_at>now() FOR SHARE OF ds,a,r,p,publisher,signing_key",
        access_query()
    ))
    .bind(session_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    access_from_row(&row)
}

pub(super) async fn load_proof(
    tx: &mut Transaction<'_, Postgres>,
    principal: &PrincipalRef,
    receipt_id: Uuid,
) -> Result<Proof, WorkflowError> {
    let row = sqlx::query(&format!(
        "SELECT access.*,ir.id receipt_id,ir.client_instance_id,ir.receipt_public_key, \
         ir.challenge_nonce,encode(ir.host_profile_digest,'hex') host_profile_digest, \
         ir.created_at receipt_issued_at,ir.challenge_expires_at,ir.status receipt_status FROM ({}) access \
         JOIN install_receipts ir ON ir.download_session_id=access.download_session_id \
           AND ir.release_id=access.release_id AND ir.artifact_id=access.artifact_id \
           AND ir.installed_digest=decode(access.canonical_digest,'hex') \
           AND ir.archive_digest=decode(access.archive_digest,'hex') \
           AND ir.principal_issuer=access.session_principal_issuer \
           AND ir.principal_subject=access.session_principal_subject \
         WHERE ir.id=$1 AND ir.principal_issuer=$2 AND ir.principal_subject=$3 FOR UPDATE OF ir",
        access_query()
    ))
    .bind(receipt_id)
    .bind(&principal.issuer)
    .bind(&principal.subject)
    .fetch_optional(&mut **tx)
    .await
    .map_err(|_| WorkflowError::Database)?
    .ok_or(WorkflowError::NotFound)?;
    let access = access_from_row(&row)?;
    Ok(Proof {
        access,
        receipt_id: row
            .try_get("receipt_id")
            .map_err(|_| WorkflowError::Database)?,
        client_instance_id: row
            .try_get("client_instance_id")
            .map_err(|_| WorkflowError::Database)?,
        receipt_public_key: bytes32(&row, "receipt_public_key")?,
        nonce: row
            .try_get("challenge_nonce")
            .map_err(|_| WorkflowError::Database)?,
        host_profile_digest: row
            .try_get("host_profile_digest")
            .map_err(|_| WorkflowError::Database)?,
        issued_at: row
            .try_get("receipt_issued_at")
            .map_err(|_| WorkflowError::Database)?,
        expires_at: row
            .try_get("challenge_expires_at")
            .map_err(|_| WorkflowError::Database)?,
        status: row
            .try_get("receipt_status")
            .map_err(|_| WorkflowError::Database)?,
    })
}

fn access_query() -> &'static str {
    r#"SELECT ds.id download_session_id,ds.principal_issuer session_principal_issuer,
       ds.principal_subject session_principal_subject,a.id artifact_id,r.id release_id,p.id package_id,
       publisher.id publisher_id,publisher.slug::text publisher_slug,p.slug::text package_slug,
       p.kind,r.version,r.compatibility,r.permissions,encode(a.canonical_sha256,'hex') canonical_digest,
       encode(a.sha256,'hex') archive_digest,a.size_bytes,a.media_type,signing_key.key_id signing_key_id,
       signing_key.public_key signing_public_key
FROM download_sessions ds
JOIN artifacts a ON a.id=ds.artifact_id
JOIN releases r ON r.id=a.release_id AND r.id=ds.release_id
JOIN published_release_artifacts published ON published.release_id=r.id AND published.artifact_id=a.id
JOIN packages p ON p.id=r.package_id AND p.id=ds.package_id
JOIN publishers publisher ON publisher.id=p.publisher_id AND publisher.id=ds.publisher_id
JOIN publisher_signing_keys signing_key ON signing_key.publisher_id=p.publisher_id
  AND signing_key.key_id=a.signature->>'keyId' AND signing_key.status='active'
WHERE a.status='verified' AND r.status='published' AND p.status='published' AND publisher.status='active'
  AND p.kind IN ('art','capability') AND a.sha256 IS NOT NULL AND a.canonical_sha256 IS NOT NULL
  AND a.size_bytes IS NOT NULL AND a.media_type IS NOT NULL
  AND ds.digest=a.canonical_sha256 AND ds.object_key=a.published_object_key
  AND a.published_object_key='sha256/' || left(encode(a.canonical_sha256,'hex'),2) || '/' || encode(a.canonical_sha256,'hex')
  AND (p.visibility<>'private' OR EXISTS(SELECT 1 FROM publisher_members member WHERE
    member.publisher_id=p.publisher_id AND member.principal_issuer=ds.principal_issuer
    AND member.principal_subject=ds.principal_subject AND member.status='active'))
  AND NOT EXISTS(SELECT 1 FROM blocklist_entries block WHERE block.status='active' AND
    (block.target_type,block.target_ref) IN (('publisher',p.publisher_id::text),('package',p.id::text),
      ('release',r.id::text),('artifact',a.id::text),
      ('signing_key',p.publisher_id::text || ':' || signing_key.key_id)))"#
}

fn access_from_row(row: &PgRow) -> Result<InstallAccess, WorkflowError> {
    let kind = match row
        .try_get::<String, _>("kind")
        .map_err(|_| WorkflowError::Database)?
        .as_str()
    {
        "art" => PackageKind::Art,
        "capability" => PackageKind::Capability,
        _ => return Err(WorkflowError::InvalidState),
    };
    let compatibility_value: Value = row
        .try_get("compatibility")
        .map_err(|_| WorkflowError::Database)?;
    let compatibility = if compatibility_value
        .as_object()
        .is_some_and(|value| value.is_empty())
    {
        PublicCompatibility::default()
    } else {
        serde_json::from_value(compatibility_value).map_err(|_| WorkflowError::InvalidState)?
    };
    if !compatibility.validate() {
        return Err(WorkflowError::InvalidState);
    }
    let size: i64 = row
        .try_get("size_bytes")
        .map_err(|_| WorkflowError::Database)?;
    let permissions = serde_json::from_value(
        row.try_get::<Value, _>("permissions")
            .map_err(|_| WorkflowError::Database)?,
    )
    .map_err(|_| WorkflowError::InvalidState)?;
    Ok(InstallAccess {
        download_session_id: row
            .try_get("download_session_id")
            .map_err(|_| WorkflowError::Database)?,
        artifact_id: row
            .try_get("artifact_id")
            .map_err(|_| WorkflowError::Database)?,
        release_id: row
            .try_get("release_id")
            .map_err(|_| WorkflowError::Database)?,
        package_id: row
            .try_get("package_id")
            .map_err(|_| WorkflowError::Database)?,
        publisher_id: row
            .try_get("publisher_id")
            .map_err(|_| WorkflowError::Database)?,
        publisher_slug: row
            .try_get("publisher_slug")
            .map_err(|_| WorkflowError::Database)?,
        package_slug: row
            .try_get("package_slug")
            .map_err(|_| WorkflowError::Database)?,
        kind,
        version: row
            .try_get("version")
            .map_err(|_| WorkflowError::Database)?,
        compatibility,
        permissions,
        canonical_digest: row
            .try_get("canonical_digest")
            .map_err(|_| WorkflowError::Database)?,
        archive_digest: row
            .try_get("archive_digest")
            .map_err(|_| WorkflowError::Database)?,
        size_bytes: u64::try_from(size).map_err(|_| WorkflowError::InvalidState)?,
        media_type: row
            .try_get("media_type")
            .map_err(|_| WorkflowError::Database)?,
        signing_key_id: row
            .try_get("signing_key_id")
            .map_err(|_| WorkflowError::Database)?,
        signing_public_key: bytes32(row, "signing_public_key")?,
    })
}

pub(super) fn challenge_contract(
    access: &InstallAccess,
    receipt_id: Uuid,
    client_instance_id: Uuid,
    nonce: Uuid,
    host_profile_sha256: String,
    issued_at: OffsetDateTime,
    expires_at: OffsetDateTime,
) -> Result<InstallChallenge, WorkflowError> {
    let fingerprint = hex::encode(Sha256::digest(access.signing_public_key));
    let challenge = InstallChallenge {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        receipt_id,
        download_session_id: access.download_session_id,
        client_instance_id,
        package: InstallPackage {
            package_id: access.package_id,
            publisher_id: access.publisher_id,
            publisher_slug: access.publisher_slug.clone(),
            package_slug: access.package_slug.clone(),
            kind: access.kind.clone(),
            version: access.version.clone(),
            permissions: access.permissions.clone(),
        },
        artifact: DownloadArtifact {
            artifact_id: access.artifact_id,
            release_id: access.release_id,
            digest: access.canonical_digest.clone(),
            size_bytes: access.size_bytes,
            media_type: access.media_type.clone(),
            file_name: file_name(&access.package_slug, &access.version),
        },
        archive_sha256: access.archive_digest.clone(),
        trusted_signing_key: TrustedPublisherKey {
            key_id: access.signing_key_id.clone(),
            algorithm: SigningKeyAlgorithm::Ed25519,
            public_key_base64: STANDARD.encode(access.signing_public_key),
            fingerprint: format!("sha256:{fingerprint}"),
        },
        host_profile_sha256,
        nonce,
        issued_at: issued_at
            .format(&Rfc3339)
            .map_err(|_| WorkflowError::Database)?,
        expires_at: expires_at
            .format(&Rfc3339)
            .map_err(|_| WorkflowError::Database)?,
    };
    challenge
        .validate()
        .then_some(challenge)
        .ok_or(WorkflowError::InvalidState)
}

pub(super) fn release_compatible(
    compatibility: &PublicCompatibility,
    host: &InstallHostProfile,
) -> bool {
    compatibility.products.iter().all(|requirement| {
        let host_version = match requirement.name {
            HostProduct::Loom => &host.loom_version,
            HostProduct::Hook => &host.hook_version,
        };
        Version::parse(host_version).ok().is_some_and(|version| {
            VersionReq::parse(&requirement.version_requirement)
                .ok()
                .is_some_and(|requirement| requirement.matches(&version))
        })
    })
}

fn bytes32(row: &PgRow, name: &str) -> Result<[u8; 32], WorkflowError> {
    row.try_get::<Vec<u8>, _>(name)
        .map_err(|_| WorkflowError::Database)?
        .try_into()
        .map_err(|_| WorkflowError::InvalidState)
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
