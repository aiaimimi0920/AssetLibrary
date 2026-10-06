use reqwest::Url;
use std::{env, fmt};

#[path = "mode.rs"]
pub mod mode;
#[path = "search_config.rs"]
pub mod search;
#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

use mode::IndexerMode;
use search::SearchConfig;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Environment {
    Development,
    Staging,
    Production,
}

#[derive(Clone)]
pub struct EdgePolicyConfig {
    pub api_base: Url,
    pub account_id: String,
    pub namespace_id: String,
    pub api_token: String,
}

impl fmt::Debug for EdgePolicyConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("EdgePolicyConfig")
            .field("api_base", &self.api_base)
            .field("account_id", &self.account_id)
            .field("namespace_id", &self.namespace_id)
            .field("api_token", &"[REDACTED_SECRET]")
            .finish()
    }
}

#[derive(Clone)]
pub struct Config {
    pub database_url: String,
    pub nats_url: String,
    pub mode: IndexerMode,
    pub search: Option<SearchConfig>,
    pub consumer_name: String,
    pub edge_policy: Option<EdgePolicyConfig>,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("database_url", &"[REDACTED_URL]")
            .field("nats_url", &"[REDACTED_URL]")
            .field("mode", &self.mode)
            .field("search", &self.search)
            .field("consumer_name", &self.consumer_name)
            .field("edge_policy", &self.edge_policy)
            .finish()
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    pub fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let mode = IndexerMode::parse(get("ASSETLIBRARY_INDEXER_MODE"))?;
        let environment = match get("ASSETLIBRARY_ENVIRONMENT")
            .unwrap_or_else(|| "development".to_owned())
            .as_str()
        {
            "development" => Environment::Development,
            "staging" => Environment::Staging,
            "production" => Environment::Production,
            value => return Err(format!("unsupported ASSETLIBRARY_ENVIRONMENT: {value}")),
        };
        let edge_values = (
            get("ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID"),
            get("ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID"),
            get("ASSETLIBRARY_EDGE_POLICY_API_TOKEN"),
        );
        let edge_policy = match edge_values {
            (Some(account_id), Some(namespace_id), Some(api_token)) => Some(EdgePolicyConfig {
                api_base: parse_origin(
                    "ASSETLIBRARY_EDGE_POLICY_API_BASE",
                    get("ASSETLIBRARY_EDGE_POLICY_API_BASE")
                        .unwrap_or_else(|| "https://api.cloudflare.com/client/v4".to_owned()),
                )?,
                account_id: identifier("edge policy account ID", account_id)?,
                namespace_id: identifier("edge policy namespace ID", namespace_id)?,
                api_token: bounded_secret(api_token)?,
            }),
            (None, None, None) => None,
            _ => {
                return Err(
                    "edge policy account, namespace, and API token must be configured together"
                        .to_owned(),
                );
            }
        };
        if (environment != Environment::Development || mode == IndexerMode::EdgePolicy)
            && edge_policy.is_none()
        {
            return Err("edge policy configuration is required for edge-policy mode and outside development".to_owned());
        }
        let nats_url = required(&get, "NATS_URL")?;
        if environment != Environment::Development {
            if !nats_url.starts_with("tls://") {
                return Err("NATS must use TLS outside development".to_owned());
            }
            if edge_policy
                .as_ref()
                .is_some_and(|edge| edge.api_base.scheme() != "https")
            {
                return Err("edge policy API must use HTTPS outside development".to_owned());
            }
        }
        let search = match mode {
            IndexerMode::SearchEdge => Some(SearchConfig::from_lookup(environment, &get)?),
            IndexerMode::EdgePolicy => None,
        };
        Ok(Self {
            database_url: required(&get, "DATABASE_URL")?,
            nats_url,
            mode,
            search,
            consumer_name: mode.consumer(
                get("ASSETLIBRARY_INDEXER_CONSUMER")
                    .unwrap_or_else(|| "assetlibrary-indexer-v1".to_owned()),
            )?,
            edge_policy,
        })
    }
}

fn required(get: &impl Fn(&str) -> Option<String>, name: &str) -> Result<String, String> {
    get(name)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn parse_origin(name: &str, value: String) -> Result<Url, String> {
    let url = Url::parse(&value).map_err(|error| format!("invalid {name}: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(format!(
            "{name} must be an HTTP(S) origin without credentials, query, or fragment"
        ));
    }
    Ok(url)
}

fn safe_name(name: &str, value: String) -> Result<String, String> {
    if value.is_empty()
        || value.len() > 100
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(format!("{name} contains unsupported characters"));
    }
    Ok(value)
}

fn identifier(name: &str, value: String) -> Result<String, String> {
    if value.len() != 32 || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(format!(
            "{name} must be a 32-character hexadecimal identifier"
        ));
    }
    Ok(value)
}

fn bounded_secret(value: String) -> Result<String, String> {
    if !(20..=4096).contains(&value.len()) || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("edge policy API token has invalid length or characters".to_owned());
    }
    Ok(value)
}
