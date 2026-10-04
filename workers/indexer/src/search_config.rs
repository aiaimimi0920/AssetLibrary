use reqwest::Url;
use std::fmt;

use super::{Environment, parse_origin, required, safe_name};

#[derive(Clone)]
pub struct SearchConfig {
    pub valkey_url: String,
    pub opensearch_url: Url,
    pub opensearch_username: String,
    pub opensearch_password: String,
    pub opensearch_allow_invalid_certs: bool,
    pub index_prefix: String,
    pub alias: String,
}

impl fmt::Debug for SearchConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("SearchConfig")
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
            .finish()
    }
}

impl SearchConfig {
    pub(super) fn from_lookup(
        environment: Environment,
        get: &impl Fn(&str) -> Option<String>,
    ) -> Result<Self, String> {
        let opensearch_url = parse_origin(
            "ASSETLIBRARY_OPENSEARCH_URL",
            required(get, "ASSETLIBRARY_OPENSEARCH_URL")?,
        )?;
        let allow_invalid =
            get("ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS").is_some_and(|value| value == "true");
        let loopback = matches!(opensearch_url.host_str(), Some("127.0.0.1" | "localhost"));
        if opensearch_url.scheme() != "https" && !loopback {
            return Err("OpenSearch must use HTTPS outside loopback development".to_owned());
        }
        if allow_invalid && !loopback {
            return Err(
                "invalid OpenSearch certificates may be accepted only on loopback".to_owned(),
            );
        }
        let valkey_url = required(get, "ASSETLIBRARY_VALKEY_URL")?;
        if environment != Environment::Development && !valkey_url.starts_with("rediss://") {
            return Err("Valkey must use TLS outside development".to_owned());
        }
        Ok(Self {
            valkey_url,
            opensearch_url,
            opensearch_username: required(get, "ASSETLIBRARY_OPENSEARCH_USERNAME")?,
            opensearch_password: required(get, "ASSETLIBRARY_OPENSEARCH_PASSWORD")?,
            opensearch_allow_invalid_certs: allow_invalid,
            index_prefix: safe_name(
                "index prefix",
                get("ASSETLIBRARY_SEARCH_INDEX_PREFIX")
                    .unwrap_or_else(|| "assetlibrary-packages-v1".to_owned()),
            )?,
            alias: safe_name(
                "index alias",
                get("ASSETLIBRARY_SEARCH_ALIAS")
                    .unwrap_or_else(|| "assetlibrary-packages".to_owned()),
            )?,
        })
    }
}
