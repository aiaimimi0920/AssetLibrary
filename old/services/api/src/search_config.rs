use super::{Environment, validate_label};
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchProvider {
    OpenSearch,
    Postgres,
}

impl SearchProvider {
    pub(super) fn from_value(value: Option<String>) -> Result<Self, String> {
        match value.as_deref() {
            None | Some("opensearch") => Ok(Self::OpenSearch),
            Some("postgres") => Ok(Self::Postgres),
            Some(value) => Err(format!("unsupported ASSETLIBRARY_SEARCH_PROVIDER: {value}")),
        }
    }
}

#[derive(Clone)]
pub struct SearchConfig {
    pub opensearch_url: reqwest::Url,
    pub opensearch_username: String,
    pub opensearch_password: String,
    pub allow_invalid_certs: bool,
    pub valkey_url: String,
    pub alias: String,
}

impl fmt::Debug for SearchConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SearchConfig")
            .field("opensearch_url", &self.opensearch_url)
            .field("opensearch_username", &self.opensearch_username)
            .field("opensearch_password", &"[REDACTED_SECRET]")
            .field("allow_invalid_certs", &self.allow_invalid_certs)
            .field("valkey_url", &"[REDACTED_URL]")
            .field("alias", &self.alias)
            .finish()
    }
}

impl SearchConfig {
    pub(super) fn from_lookup(
        provider: SearchProvider,
        get: &impl Fn(&str) -> Option<String>,
    ) -> Result<Option<Self>, String> {
        // Switching providers must not parse or require unused legacy settings.
        if provider == SearchProvider::Postgres {
            return Ok(None);
        }
        let values = (
            get("ASSETLIBRARY_OPENSEARCH_URL"),
            get("ASSETLIBRARY_OPENSEARCH_USERNAME"),
            get("ASSETLIBRARY_OPENSEARCH_PASSWORD"),
            get("ASSETLIBRARY_VALKEY_URL"),
        );
        match values {
            (Some(url), Some(username), Some(password), Some(valkey_url)) => {
                let opensearch_url = reqwest::Url::parse(&url)
                    .map_err(|error| format!("invalid OpenSearch URL: {error}"))?;
                if !matches!(opensearch_url.scheme(), "http" | "https")
                    || opensearch_url.host_str().is_none()
                    || !opensearch_url.username().is_empty()
                    || opensearch_url.password().is_some()
                {
                    return Err(
                        "OpenSearch URL must be an HTTP(S) origin without credentials".to_owned(),
                    );
                }
                let valkey = reqwest::Url::parse(&valkey_url)
                    .map_err(|error| format!("invalid Valkey URL: {error}"))?;
                if !matches!(valkey.scheme(), "redis" | "rediss") || valkey.host_str().is_none() {
                    return Err("Valkey URL must use redis or rediss".to_owned());
                }
                Ok(Some(Self {
                    opensearch_url,
                    opensearch_username: validate_label("OpenSearch username", username)?,
                    opensearch_password: validate_secret("OpenSearch password", password)?,
                    allow_invalid_certs: get("ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS")
                        .is_some_and(|value| value == "true"),
                    valkey_url,
                    alias: validate_search_name(
                        get("ASSETLIBRARY_SEARCH_ALIAS")
                            .unwrap_or_else(|| "assetlibrary-packages".to_owned()),
                    )?,
                }))
            }
            (None, None, None, None) => Ok(None),
            _ => {
                Err("OpenSearch credentials and Valkey URL must be configured together".to_owned())
            }
        }
    }

    pub(super) fn validate(&self, environment: Environment) -> Result<(), String> {
        let loopback = matches!(
            self.opensearch_url.host_str(),
            Some("127.0.0.1" | "localhost")
        );
        if environment != Environment::Development
            && (self.opensearch_url.scheme() != "https"
                || !self.valkey_url.starts_with("rediss://"))
        {
            return Err("OpenSearch and Valkey must use TLS outside development".to_owned());
        }
        if self.allow_invalid_certs && !loopback {
            return Err(
                "invalid OpenSearch certificates may be accepted only on loopback".to_owned(),
            );
        }
        Ok(())
    }
}

fn validate_secret(name: &str, value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > 4096 || !value.bytes().all(|byte| byte.is_ascii_graphic())
    {
        return Err(format!("{name} has invalid length or characters"));
    }
    Ok(value)
}

fn validate_search_name(value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("search alias contains unsupported characters".to_owned());
    }
    Ok(value)
}
