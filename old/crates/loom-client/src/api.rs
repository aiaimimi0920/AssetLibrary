use assetlibrary_contracts::{
    CreateDownloadSessionRequest, CreateInstallChallengeRequest, DownloadArtifact,
    DownloadClientType, DownloadSession, InstallChallenge, InstallReceipt, PublishedReleasePage,
    VerifyInstallReceiptRequest,
};
use reqwest::{Client, StatusCode, header};
use std::fmt;
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use url::Url;
use uuid::Uuid;

use crate::{ClientConfig, ClientError};

#[derive(Clone)]
pub struct AccountBearer(reqwest::header::HeaderValue);

impl AccountBearer {
    pub fn new(token: &str) -> Result<Self, ClientError> {
        if token.is_empty() || token.len() > 8192 || token.starts_with("Bearer ") {
            return Err(ClientError::InvalidInput("invalid account bearer"));
        }
        let value = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| ClientError::InvalidInput("invalid account bearer"))?;
        Ok(Self(value))
    }
}

impl fmt::Debug for AccountBearer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("AccountBearer([REDACTED])")
    }
}

struct DownloadTicket(reqwest::header::HeaderValue);

impl fmt::Debug for DownloadTicket {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("DownloadTicket([REDACTED])")
    }
}

#[derive(Debug)]
pub struct LoomDownloadSession {
    pub session_id: Uuid,
    pub artifact: DownloadArtifact,
    pub download_url: Url,
    pub expires_at: OffsetDateTime,
    ticket: DownloadTicket,
}

impl LoomDownloadSession {
    fn from_contract(value: DownloadSession) -> Result<Self, ClientError> {
        if !value.validate() {
            return Err(ClientError::InvalidResponse);
        }
        let download_url =
            Url::parse(&value.download_url).map_err(|_| ClientError::InvalidResponse)?;
        let expires_at = OffsetDateTime::parse(&value.expires_at, &Rfc3339)
            .map_err(|_| ClientError::InvalidResponse)?;
        let ticket =
            reqwest::header::HeaderValue::from_str(&format!("Bearer {}", value.access_token))
                .map_err(|_| ClientError::InvalidResponse)?;
        Ok(Self {
            session_id: value.session_id,
            artifact: value.artifact,
            download_url,
            expires_at,
            ticket: DownloadTicket(ticket),
        })
    }

    pub(crate) fn authorization(&self) -> reqwest::header::HeaderValue {
        self.ticket.0.clone()
    }
}

#[derive(Clone)]
pub struct LoomApiClient {
    pub(crate) http: Client,
    pub(crate) config: ClientConfig,
}

impl LoomApiClient {
    pub fn new(config: ClientConfig) -> Result<Self, ClientError> {
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(config.request_timeout)
            .user_agent(concat!(
                "assetlibrary-loom-client/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()?;
        Ok(Self { http, config })
    }

    pub async fn list_releases(
        &self,
        package_slug: &str,
        cursor: Option<&str>,
        limit: u8,
    ) -> Result<PublishedReleasePage, ClientError> {
        if !safe_slug(package_slug)
            || !(1..=100).contains(&limit)
            || cursor.is_some_and(|value| value.is_empty() || value.len() > 256)
        {
            return Err(ClientError::InvalidInput("invalid release page request"));
        }
        let mut url = self.endpoint(&format!("v1/public/packages/{package_slug}/releases"))?;
        {
            let mut query = url.query_pairs_mut();
            query.append_pair("limit", &limit.to_string());
            if let Some(cursor) = cursor {
                query.append_pair("cursor", cursor);
            }
        }
        let response = self
            .http
            .get(url)
            .timeout(self.config.request_timeout)
            .send()
            .await?;
        let page: PublishedReleasePage = decode(response, StatusCode::OK).await?;
        page.validate()
            .then_some(page)
            .ok_or(ClientError::InvalidResponse)
    }

    pub async fn create_download_session(
        &self,
        account: &AccountBearer,
        artifact_id: Uuid,
        idempotency_key: &str,
    ) -> Result<LoomDownloadSession, ClientError> {
        valid_uuid_key(artifact_id, idempotency_key)?;
        let url = self.endpoint(&format!("v1/me/artifacts/{artifact_id}/download-sessions"))?;
        let response = self
            .http
            .post(url)
            .timeout(self.config.request_timeout)
            .header(header::AUTHORIZATION, account.0.clone())
            .header("Idempotency-Key", idempotency_key)
            .json(&CreateDownloadSessionRequest {
                client_type: DownloadClientType::Loom,
            })
            .send()
            .await?;
        LoomDownloadSession::from_contract(
            decode_secure(response, StatusCode::CREATED, false).await?,
        )
    }

    pub async fn create_install_challenge(
        &self,
        account: &AccountBearer,
        session_id: Uuid,
        idempotency_key: &str,
        request: &CreateInstallChallengeRequest,
    ) -> Result<InstallChallenge, ClientError> {
        valid_uuid_key(session_id, idempotency_key)?;
        if !request.validate() {
            return Err(ClientError::InvalidInput("invalid install challenge"));
        }
        let url = self.endpoint(&format!(
            "v1/me/download-sessions/{session_id}/install-challenge"
        ))?;
        let response = self
            .http
            .post(url)
            .timeout(self.config.request_timeout)
            .header(header::AUTHORIZATION, account.0.clone())
            .header("Idempotency-Key", idempotency_key)
            .json(request)
            .send()
            .await?;
        let challenge: InstallChallenge =
            decode_secure(response, StatusCode::CREATED, true).await?;
        challenge
            .validate()
            .then_some(challenge)
            .ok_or(ClientError::InvalidResponse)
    }

    pub async fn verify_install_receipt(
        &self,
        account: &AccountBearer,
        receipt_id: Uuid,
        idempotency_key: &str,
        request: &VerifyInstallReceiptRequest,
    ) -> Result<InstallReceipt, ClientError> {
        valid_uuid_key(receipt_id, idempotency_key)?;
        if !request.validate() {
            return Err(ClientError::InvalidInput("invalid install receipt"));
        }
        let url = self.endpoint(&format!("v1/me/install-receipts/{receipt_id}/verify"))?;
        let response = self
            .http
            .post(url)
            .timeout(self.config.request_timeout)
            .header(header::AUTHORIZATION, account.0.clone())
            .header("Idempotency-Key", idempotency_key)
            .json(request)
            .send()
            .await?;
        let receipt: InstallReceipt = decode_secure(response, StatusCode::OK, true).await?;
        validate_receipt(&receipt, receipt_id)
            .then_some(receipt)
            .ok_or(ClientError::InvalidResponse)
    }

    pub(crate) fn validate_download_url(&self, url: &Url) -> Result<(), ClientError> {
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
            || !self.config.allows_download(url)
        {
            return Err(ClientError::DownloadOriginDenied);
        }
        Ok(())
    }

    fn endpoint(&self, path: &str) -> Result<Url, ClientError> {
        self.config
            .api_base_url
            .join(path)
            .map_err(|_| ClientError::Configuration("invalid API endpoint"))
    }
}

async fn decode<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    expected: StatusCode,
) -> Result<T, ClientError> {
    if response.status() != expected {
        return Err(ClientError::HttpStatus(response.status().as_u16()));
    }
    response
        .json::<T>()
        .await
        .map_err(|_| ClientError::InvalidResponse)
}

async fn decode_secure<T: serde::de::DeserializeOwned>(
    response: reqwest::Response,
    expected: StatusCode,
    private: bool,
) -> Result<T, ClientError> {
    if response.status() != expected {
        return Err(ClientError::HttpStatus(response.status().as_u16()));
    }
    require_no_store(&response, private)?;
    response
        .json::<T>()
        .await
        .map_err(|_| ClientError::InvalidResponse)
}

fn valid_uuid_key(id: Uuid, key: &str) -> Result<(), ClientError> {
    if id.is_nil()
        || !(8..=200).contains(&key.len())
        || key.trim() != key
        || key.chars().any(char::is_control)
    {
        return Err(ClientError::InvalidInput("invalid idempotent mutation"));
    }
    Ok(())
}

fn safe_slug(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 120
        && value.bytes().enumerate().all(|(index, byte)| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || (index > 0 && byte == b'-')
        })
}

fn validate_receipt(receipt: &InstallReceipt, expected: Uuid) -> bool {
    receipt.schema_version == assetlibrary_contracts::SCHEMA_VERSION_V1
        && receipt.receipt_id == expected
        && !receipt.release_id.is_nil()
        && !receipt.artifact_id.is_nil()
        && receipt.digest.len() == 64
        && receipt
            .digest
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        && receipt.status == "verified"
        && OffsetDateTime::parse(&receipt.installed_at, &Rfc3339).is_ok()
        && OffsetDateTime::parse(&receipt.verified_at, &Rfc3339).is_ok()
}

fn require_no_store(response: &reqwest::Response, private: bool) -> Result<(), ClientError> {
    let directives = response
        .headers()
        .get(header::CACHE_CONTROL)
        .and_then(|value| value.to_str().ok())
        .map(|value| {
            value
                .split(',')
                .map(|part| part.trim().to_ascii_lowercase())
                .collect::<std::collections::BTreeSet<_>>()
        })
        .ok_or(ClientError::InvalidResponse)?;
    if !directives.contains("no-store") || (private && !directives.contains("private")) {
        return Err(ClientError::InvalidResponse);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::AccountBearer;

    #[test]
    fn secrets_are_redacted() {
        let bearer = AccountBearer::new("opaque-account-token").unwrap();
        assert_eq!(format!("{bearer:?}"), "AccountBearer([REDACTED])");
    }
}
