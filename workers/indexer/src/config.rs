use reqwest::Url;
use std::{env, fmt};

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
    pub valkey_url: String,
    pub opensearch_url: Url,
    pub opensearch_username: String,
    pub opensearch_password: String,
    pub opensearch_allow_invalid_certs: bool,
    pub index_prefix: String,
    pub alias: String,
    pub consumer_name: String,
    pub edge_policy: Option<EdgePolicyConfig>,
}

impl fmt::Debug for Config {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("Config")
            .field("database_url", &"[REDACTED_URL]")
            .field("nats_url", &"[REDACTED_URL]")
            .field("valkey_url", &"[REDACTED_URL]")
            .field("opensearch_url", &self.opensearch_url)
            .field("opensearch_username", &self.opensearch_username)
            .field("opensearch_password", &"[REDACTED_SECRET]")
            .field(
                "opensearch_allow_invalid_certs",
                &self.opensearch_allow_invalid_certs,
            )
            .field("index_prefix", &self.index_prefix)
            .field("alias", &self.alias)
            .field("consumer_name", &self.consumer_name)
            .field("edge_policy", &self.edge_policy)
            .finish()
    }
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let environment = match env::var("ASSETLIBRARY_ENVIRONMENT")
            .unwrap_or_else(|_| "development".to_owned())
            .as_str()
        {
            "development" => Environment::Development,
            "staging" => Environment::Staging,
            "production" => Environment::Production,
            value => return Err(format!("unsupported ASSETLIBRARY_ENVIRONMENT: {value}")),
        };
        let opensearch_url = parse_origin(
            "ASSETLIBRARY_OPENSEARCH_URL",
            required("ASSETLIBRARY_OPENSEARCH_URL")?,
        )?;
        let allow_invalid = env::var("ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS")
            .is_ok_and(|value| value == "true");
        let loopback = matches!(opensearch_url.host_str(), Some("127.0.0.1" | "localhost"));
        if opensearch_url.scheme() != "https" && !loopback {
            return Err("OpenSearch must use HTTPS outside loopback development".to_owned());
        }
        if allow_invalid && !loopback {
            return Err(
                "invalid OpenSearch certificates may be accepted only on loopback".to_owned(),
            );
        }
        let edge_values = (
            env::var("ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID").ok(),
            env::var("ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID").ok(),
            env::var("ASSETLIBRARY_EDGE_POLICY_API_TOKEN").ok(),
        );
        let edge_policy = match edge_values {
            (Some(account_id), Some(namespace_id), Some(api_token)) => Some(EdgePolicyConfig {
                api_base: parse_origin(
                    "ASSETLIBRARY_EDGE_POLICY_API_BASE",
                    env::var("ASSETLIBRARY_EDGE_POLICY_API_BASE")
                        .unwrap_or_else(|_| "https://api.cloudflare.com/client/v4".to_owned()),
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
        if environment != Environment::Development && edge_policy.is_none() {
            return Err("edge policy configuration is required outside development".to_owned());
        }
        if environment != Environment::Development {
            if !required("NATS_URL")?.starts_with("tls://") {
                return Err("NATS must use TLS outside development".to_owned());
            }
            if !required("ASSETLIBRARY_VALKEY_URL")?.starts_with("rediss://") {
                return Err("Valkey must use TLS outside development".to_owned());
            }
            if edge_policy
                .as_ref()
                .is_some_and(|edge| edge.api_base.scheme() != "https")
            {
                return Err("edge policy API must use HTTPS outside development".to_owned());
            }
        }
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            nats_url: required("NATS_URL")?,
            valkey_url: required("ASSETLIBRARY_VALKEY_URL")?,
            opensearch_url,
            opensearch_username: required("ASSETLIBRARY_OPENSEARCH_USERNAME")?,
            opensearch_password: required("ASSETLIBRARY_OPENSEARCH_PASSWORD")?,
            opensearch_allow_invalid_certs: allow_invalid,
            index_prefix: safe_name(
                "index prefix",
                env::var("ASSETLIBRARY_SEARCH_INDEX_PREFIX")
                    .unwrap_or_else(|_| "assetlibrary-packages-v1".to_owned()),
            )?,
            alias: safe_name(
                "index alias",
                env::var("ASSETLIBRARY_SEARCH_ALIAS")
                    .unwrap_or_else(|_| "assetlibrary-packages".to_owned()),
            )?,
            consumer_name: safe_name(
                "consumer name",
                env::var("ASSETLIBRARY_INDEXER_CONSUMER")
                    .unwrap_or_else(|_| "assetlibrary-indexer-v1".to_owned()),
            )?,
            edge_policy,
        })
    }
}

fn required(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
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
