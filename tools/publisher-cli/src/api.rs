use assetlibrary_contracts::{
    CompleteUploadSessionRequest, CreatePackageRequest, CreateReleaseRequest,
    CreateSubmissionRequest, CreateUploadSessionRequest, OwnedPackage, OwnedRelease,
    PresignUploadPartRequest, PresignedUploadPart, PublisherReleaseWorkspace,
    ResumableUploadSession, SubmissionView, UploadSession,
};
use reqwest::{Client, StatusCode, header};
use serde::{Serialize, de::DeserializeOwned};
use std::{fmt, time::Duration};
use url::Url;
use uuid::Uuid;

use crate::{cli::RemoteArgs, error::CliError};

struct Bearer(reqwest::header::HeaderValue);

impl fmt::Debug for Bearer {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("Bearer([REDACTED])")
    }
}

pub struct PublisherApi {
    base: Url,
    bearer: Bearer,
    http: Client,
}

impl PublisherApi {
    pub fn new(remote: &RemoteArgs) -> Result<Self, CliError> {
        let mut base =
            Url::parse(&remote.api_url).map_err(|_| CliError::Configuration("invalid API URL"))?;
        if base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
            || !matches!(base.scheme(), "http" | "https")
            || (base.scheme() == "http" && !remote.allow_http)
        {
            return Err(CliError::Configuration("unsafe API URL"));
        }
        if !base.path().ends_with('/') {
            base.set_path(&format!("{}/", base.path()));
        }
        if remote.token_env.is_empty()
            || remote.token_env.len() > 128
            || !remote
                .token_env
                .bytes()
                .all(|value| value.is_ascii_alphanumeric() || value == b'_')
        {
            return Err(CliError::Configuration(
                "invalid token environment variable",
            ));
        }
        let token = std::env::var(&remote.token_env)
            .map_err(|_| CliError::Configuration("Account Service bearer is unavailable"))?;
        if token.is_empty() || token.len() > 8192 || token.starts_with("Bearer ") {
            return Err(CliError::Configuration("invalid Account Service bearer"));
        }
        let bearer = reqwest::header::HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| CliError::Configuration("invalid Account Service bearer"))?;
        let http = Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(10))
            .user_agent(concat!(
                "assetlibrary-publisher/",
                env!("CARGO_PKG_VERSION")
            ))
            .build()?;
        Ok(Self {
            base,
            bearer: Bearer(bearer),
            http,
        })
    }

    pub async fn create_package(
        &self,
        publisher_id: Uuid,
        key: &str,
        request: &CreatePackageRequest,
    ) -> Result<OwnedPackage, CliError> {
        self.post(
            &format!("v1/me/publishers/{publisher_id}/packages"),
            Some(key),
            request,
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn create_release(
        &self,
        package_id: Uuid,
        key: &str,
        request: &CreateReleaseRequest,
    ) -> Result<OwnedRelease, CliError> {
        self.post(
            &format!("v1/me/packages/{package_id}/releases"),
            Some(key),
            request,
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn workspace(&self, release_id: Uuid) -> Result<PublisherReleaseWorkspace, CliError> {
        let response = self
            .authorized(
                self.http
                    .get(self.url(&format!("v1/me/releases/{release_id}/workspace"))?),
            )
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        let workspace: PublisherReleaseWorkspace = decode(response, StatusCode::OK).await?;
        workspace
            .validate()
            .then_some(workspace)
            .ok_or_else(|| CliError::Validation("invalid workspace response".to_owned()))
    }

    pub async fn create_upload(
        &self,
        release_id: Uuid,
        key: &str,
        request: &CreateUploadSessionRequest,
    ) -> Result<UploadSession, CliError> {
        self.post(
            &format!("v1/me/releases/{release_id}/upload-sessions"),
            Some(key),
            request,
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn upload_status(
        &self,
        session_id: Uuid,
    ) -> Result<ResumableUploadSession, CliError> {
        let response = self
            .authorized(
                self.http
                    .get(self.url(&format!("v1/me/upload-sessions/{session_id}"))?),
            )
            .timeout(Duration::from_secs(30))
            .send()
            .await?;
        decode(response, StatusCode::OK).await
    }

    pub async fn presign_part(
        &self,
        session_id: Uuid,
        part_number: u16,
        request: &PresignUploadPartRequest,
    ) -> Result<PresignedUploadPart, CliError> {
        self.post(
            &format!("v1/me/upload-sessions/{session_id}/parts/{part_number}"),
            None,
            request,
            Duration::from_secs(30),
        )
        .await
    }

    pub async fn complete_upload(
        &self,
        session_id: Uuid,
        request: &CompleteUploadSessionRequest,
    ) -> Result<UploadSession, CliError> {
        self.post(
            &format!("v1/me/upload-sessions/{session_id}/complete"),
            None,
            request,
            Duration::from_secs(60),
        )
        .await
    }

    pub async fn submit(
        &self,
        release_id: Uuid,
        key: &str,
        request: &CreateSubmissionRequest,
    ) -> Result<SubmissionView, CliError> {
        self.post(
            &format!("v1/me/releases/{release_id}/submissions"),
            Some(key),
            request,
            Duration::from_secs(30),
        )
        .await
    }

    pub fn upload_client(&self) -> &Client {
        &self.http
    }

    pub fn scope(&self) -> &str {
        self.base.as_str().trim_end_matches('/')
    }

    async fn post<T: Serialize + ?Sized, R: DeserializeOwned>(
        &self,
        path: &str,
        idempotency_key: Option<&str>,
        request: &T,
        timeout: Duration,
    ) -> Result<R, CliError> {
        if idempotency_key.is_some_and(|value| !valid_key(value)) {
            return Err(CliError::Validation("invalid idempotency key".to_owned()));
        }
        let mut builder = self
            .authorized(self.http.post(self.url(path)?))
            .timeout(timeout)
            .header(header::ACCEPT, "application/json")
            .header("X-Request-ID", format!("publisher-{}", Uuid::new_v4()))
            .json(request);
        if let Some(key) = idempotency_key {
            builder = builder.header("Idempotency-Key", key);
        }
        decode(builder.send().await?, StatusCode::OK).await
    }

    fn authorized(&self, builder: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        builder.header(header::AUTHORIZATION, self.bearer.0.clone())
    }

    fn url(&self, path: &str) -> Result<Url, CliError> {
        self.base
            .join(path)
            .map_err(|_| CliError::Configuration("invalid API endpoint"))
    }
}

async fn decode<T: DeserializeOwned>(
    response: reqwest::Response,
    expected: StatusCode,
) -> Result<T, CliError> {
    if response.status() != expected {
        return Err(CliError::from_status(response.status()));
    }
    response
        .json::<T>()
        .await
        .map_err(|_| CliError::Validation("invalid API response".to_owned()))
}

pub fn idempotency_key(value: &Option<String>) -> Result<String, CliError> {
    let value = value
        .clone()
        .unwrap_or_else(|| format!("publisher-{}", Uuid::new_v4()));
    valid_key(&value)
        .then_some(value)
        .ok_or_else(|| CliError::Validation("invalid idempotency key".to_owned()))
}

fn valid_key(value: &str) -> bool {
    (8..=200).contains(&value.len())
        && value.trim() == value
        && value.bytes().all(|byte| byte.is_ascii_graphic())
}
