use std::{collections::BTreeSet, time::Duration};
use url::Url;

use crate::ClientError;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct DownloadOrigin {
    scheme: String,
    host: String,
    port: u16,
}

impl DownloadOrigin {
    pub fn parse(value: &str, allow_insecure_http: bool) -> Result<Self, ClientError> {
        let url = Url::parse(value).map_err(|_| ClientError::Configuration("invalid origin"))?;
        if url.cannot_be_a_base()
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.path() != "/"
            || url.query().is_some()
            || url.fragment().is_some()
            || !matches!(url.scheme(), "https" | "http")
            || (url.scheme() == "http" && !allow_insecure_http)
        {
            return Err(ClientError::Configuration("unsafe origin"));
        }
        Self::from_url(&url).ok_or(ClientError::Configuration("invalid origin"))
    }

    pub(crate) fn from_url(url: &Url) -> Option<Self> {
        Some(Self {
            scheme: url.scheme().to_owned(),
            host: url.host_str()?.to_ascii_lowercase(),
            port: url.port_or_known_default()?,
        })
    }
}

#[derive(Clone, Debug)]
pub struct ClientConfig {
    pub(crate) api_base_url: Url,
    pub(crate) download_origins: BTreeSet<DownloadOrigin>,
    pub(crate) request_timeout: Duration,
    pub(crate) stall_timeout: Duration,
    pub(crate) retry_limit: u8,
    pub(crate) allow_insecure_http: bool,
}

impl ClientConfig {
    pub fn new(
        api_base_url: &str,
        download_origins: impl IntoIterator<Item = DownloadOrigin>,
        allow_insecure_http: bool,
    ) -> Result<Self, ClientError> {
        let mut api_base_url = Url::parse(api_base_url)
            .map_err(|_| ClientError::Configuration("invalid API base URL"))?;
        if api_base_url.host_str().is_none()
            || !api_base_url.username().is_empty()
            || api_base_url.password().is_some()
            || api_base_url.query().is_some()
            || api_base_url.fragment().is_some()
            || !matches!(api_base_url.scheme(), "https" | "http")
            || (api_base_url.scheme() == "http" && !allow_insecure_http)
        {
            return Err(ClientError::Configuration("unsafe API base URL"));
        }
        if !api_base_url.path().ends_with('/') {
            api_base_url.set_path(&format!("{}/", api_base_url.path()));
        }
        let download_origins = download_origins.into_iter().collect::<BTreeSet<_>>();
        if download_origins.is_empty() {
            return Err(ClientError::Configuration(
                "download origin allowlist is empty",
            ));
        }
        Ok(Self {
            api_base_url,
            download_origins,
            request_timeout: Duration::from_secs(30),
            stall_timeout: Duration::from_secs(30),
            retry_limit: 3,
            allow_insecure_http,
        })
    }

    pub fn with_timeouts(
        mut self,
        request: Duration,
        stall: Duration,
    ) -> Result<Self, ClientError> {
        if request.is_zero() || stall.is_zero() {
            return Err(ClientError::Configuration("timeouts must be positive"));
        }
        self.request_timeout = request;
        self.stall_timeout = stall;
        Ok(self)
    }

    pub fn with_retry_limit(mut self, retry_limit: u8) -> Result<Self, ClientError> {
        if retry_limit > 8 {
            return Err(ClientError::Configuration("retry limit exceeds eight"));
        }
        self.retry_limit = retry_limit;
        Ok(self)
    }

    pub(crate) fn allows_download(&self, url: &Url) -> bool {
        if url.scheme() == "http" && !self.allow_insecure_http {
            return false;
        }
        DownloadOrigin::from_url(url).is_some_and(|origin| self.download_origins.contains(&origin))
    }
}
