use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{env, fmt, net::SocketAddr};

#[derive(Clone, Debug)]
pub struct Config {
    pub environment: Environment,
    pub bind: SocketAddr,
    pub database_url: Option<String>,
    pub oidc: Option<OidcConfig>,
    pub object_store: Option<ObjectStoreConfig>,
    pub app_updates_enabled: bool,
    pub downloads: Option<DownloadConfig>,
    pub search: Option<SearchConfig>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Environment {
    Development,
    Staging,
    Production,
}

#[derive(Clone, Debug)]
pub struct OidcConfig {
    pub issuer: String,
    pub audience: String,
    pub jwks_url: String,
}

#[derive(Clone, Debug)]
pub struct ObjectStoreConfig {
    pub endpoint_url: Option<String>,
    pub region: String,
    pub quarantine_bucket: String,
    pub published_bucket: String,
    pub force_path_style: bool,
}

#[derive(Clone)]
pub struct DownloadConfig {
    pub public_base_url: String,
    pub restricted_base_url: String,
    pub ticket_issuer: String,
    pub ticket_audience: String,
    pub ticket_secret: Vec<u8>,
    pub ticket_ttl_seconds: u16,
}

impl fmt::Debug for DownloadConfig {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("DownloadConfig")
            .field("public_base_url", &self.public_base_url)
            .field("restricted_base_url", &self.restricted_base_url)
            .field("ticket_issuer", &self.ticket_issuer)
            .field("ticket_audience", &self.ticket_audience)
            .field("ticket_secret", &"[REDACTED_SECRET]")
            .field("ticket_ttl_seconds", &self.ticket_ttl_seconds)
            .finish()
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

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let oidc_values = (
            env::var("ASSETLIBRARY_OIDC_ISSUER").ok(),
            env::var("ASSETLIBRARY_OIDC_AUDIENCE").ok(),
            env::var("ASSETLIBRARY_OIDC_JWKS_URL").ok(),
        );
        let oidc = match oidc_values {
            (Some(issuer), Some(audience), Some(jwks_url)) => Some(OidcConfig {
                issuer,
                audience,
                jwks_url,
            }),
            (None, None, None) => None,
            _ => {
                return Err(
                    "OIDC issuer, audience, and JWKS URL must be configured together".to_owned(),
                );
            }
        };
        let object_store_values = (
            env::var("ASSETLIBRARY_S3_REGION").ok(),
            env::var("ASSETLIBRARY_QUARANTINE_BUCKET").ok(),
            env::var("ASSETLIBRARY_PUBLISHED_BUCKET").ok(),
        );
        let object_store = match object_store_values {
            (Some(region), Some(quarantine_bucket), Some(published_bucket)) => {
                Some(ObjectStoreConfig {
                    endpoint_url: env::var("ASSETLIBRARY_S3_ENDPOINT").ok(),
                    region,
                    quarantine_bucket,
                    published_bucket,
                    force_path_style: env::var("ASSETLIBRARY_S3_FORCE_PATH_STYLE")
                        .map(|value| value == "true")
                        .unwrap_or(false),
                })
            }
            (None, None, None) => None,
            _ => {
                return Err(
                    "S3 region, quarantine bucket, and published bucket must be configured together"
                        .to_owned(),
                );
            }
        };
        let download_values = (
            env::var("ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL").ok(),
            env::var("ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL").ok(),
            env::var("ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER").ok(),
            env::var("ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE").ok(),
            env::var("ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64").ok(),
        );
        let downloads = match download_values {
            (Some(public), Some(restricted), Some(issuer), Some(audience), Some(secret)) => {
                let secret = URL_SAFE_NO_PAD
                    .decode(secret)
                    .map_err(|_| "download ticket secret must be unpadded base64url".to_owned())?;
                let ttl = env::var("ASSETLIBRARY_DOWNLOAD_TICKET_TTL_SECONDS")
                    .unwrap_or_else(|_| "300".to_owned())
                    .parse::<u16>()
                    .map_err(|_| "download ticket TTL must be an integer".to_owned())?;
                Some(DownloadConfig {
                    public_base_url: validate_download_url(&public)?,
                    restricted_base_url: validate_download_url(&restricted)?,
                    ticket_issuer: validate_label("download ticket issuer", issuer)?,
                    ticket_audience: validate_label("download ticket audience", audience)?,
                    ticket_secret: secret,
                    ticket_ttl_seconds: ttl,
                })
            }
            (None, None, None, None, None) => None,
            _ => {
                return Err(
                    "download URL and ticket settings must be configured together".to_owned(),
                );
            }
        };
        let search_values = (
            env::var("ASSETLIBRARY_OPENSEARCH_URL").ok(),
            env::var("ASSETLIBRARY_OPENSEARCH_USERNAME").ok(),
            env::var("ASSETLIBRARY_OPENSEARCH_PASSWORD").ok(),
            env::var("ASSETLIBRARY_VALKEY_URL").ok(),
        );
        let search = match search_values {
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
                Some(SearchConfig {
                    opensearch_url,
                    opensearch_username: validate_label("OpenSearch username", username)?,
                    opensearch_password: validate_secret("OpenSearch password", password)?,
                    allow_invalid_certs: env::var("ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS")
                        .is_ok_and(|value| value == "true"),
                    valkey_url,
                    alias: validate_search_name(
                        env::var("ASSETLIBRARY_SEARCH_ALIAS")
                            .unwrap_or_else(|_| "assetlibrary-packages".to_owned()),
                    )?,
                })
            }
            (None, None, None, None) => None,
            _ => {
                return Err(
                    "OpenSearch credentials and Valkey URL must be configured together".to_owned(),
                );
            }
        };
        Self::from_values(
            &env::var("ASSETLIBRARY_ENVIRONMENT").unwrap_or_else(|_| "development".to_owned()),
            &env::var("ASSETLIBRARY_BIND").unwrap_or_else(|_| "127.0.0.1:8080".to_owned()),
            env::var("DATABASE_URL").ok(),
            oidc,
            object_store,
            env::var("ASSETLIBRARY_APP_UPDATES_ENABLED")
                .map(|value| value == "true")
                .unwrap_or(false),
            downloads,
            search,
        )
    }

    fn from_values(
        environment: &str,
        bind: &str,
        database_url: Option<String>,
        oidc: Option<OidcConfig>,
        object_store: Option<ObjectStoreConfig>,
        app_updates_enabled: bool,
        downloads: Option<DownloadConfig>,
        search: Option<SearchConfig>,
    ) -> Result<Self, String> {
        let environment = match environment {
            "development" => Environment::Development,
            "staging" => Environment::Staging,
            "production" => Environment::Production,
            value => return Err(format!("unsupported ASSETLIBRARY_ENVIRONMENT: {value}")),
        };
        if environment != Environment::Development && app_updates_enabled {
            return Err("App Update admission gate is closed outside development".to_owned());
        }
        let bind = bind
            .parse()
            .map_err(|error| format!("invalid ASSETLIBRARY_BIND: {error}"))?;
        let database_url = database_url.filter(|value| !value.is_empty());
        if environment != Environment::Development && database_url.is_none() {
            return Err("DATABASE_URL is required outside development".to_owned());
        }
        if environment != Environment::Development && oidc.is_none() {
            return Err("OIDC configuration is required outside development".to_owned());
        }
        if environment != Environment::Development && object_store.is_none() {
            return Err("object store configuration is required outside development".to_owned());
        }
        if environment != Environment::Development && downloads.is_none() {
            return Err("download configuration is required outside development".to_owned());
        }
        if environment != Environment::Development && search.is_none() {
            return Err("search configuration is required outside development".to_owned());
        }
        if let Some(downloads) = downloads.as_ref() {
            if downloads.ticket_secret.len() < 32 {
                return Err("download ticket secret must contain at least 32 bytes".to_owned());
            }
            if !(30..=900).contains(&downloads.ticket_ttl_seconds) {
                return Err("download ticket TTL must be between 30 and 900 seconds".to_owned());
            }
            if environment != Environment::Development
                && (!downloads.public_base_url.starts_with("https://")
                    || !downloads.restricted_base_url.starts_with("https://"))
            {
                return Err("download base URLs must use HTTPS outside development".to_owned());
            }
        }
        if let Some(search) = search.as_ref() {
            let loopback = matches!(
                search.opensearch_url.host_str(),
                Some("127.0.0.1" | "localhost")
            );
            if environment != Environment::Development
                && (search.opensearch_url.scheme() != "https"
                    || !search.valkey_url.starts_with("rediss://"))
            {
                return Err("OpenSearch and Valkey must use TLS outside development".to_owned());
            }
            if search.allow_invalid_certs && !loopback {
                return Err(
                    "invalid OpenSearch certificates may be accepted only on loopback".to_owned(),
                );
            }
        }
        Ok(Self {
            environment,
            bind,
            database_url,
            oidc,
            object_store,
            app_updates_enabled,
            downloads,
            search,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{Config, Environment};

    #[test]
    fn production_requires_database_url() {
        let error = Config::from_values(
            "production",
            "127.0.0.1:8080",
            None,
            None,
            None,
            false,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error, "DATABASE_URL is required outside development");
    }

    #[test]
    fn production_requires_oidc_after_database() {
        let error = Config::from_values(
            "production",
            "127.0.0.1:8080",
            Some("postgres://database".to_owned()),
            None,
            None,
            false,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(error, "OIDC configuration is required outside development");
    }

    #[test]
    fn development_can_start_without_external_services() {
        let config = Config::from_values(
            "development",
            "127.0.0.1:8080",
            None,
            None,
            None,
            false,
            None,
            None,
        )
        .unwrap();
        assert_eq!(config.environment, Environment::Development);
        assert!(config.database_url.is_none());
        assert!(config.oidc.is_none());
        assert!(!config.app_updates_enabled);
    }

    #[test]
    fn production_cannot_enable_app_updates_before_admission() {
        let error = Config::from_values(
            "production",
            "127.0.0.1:8080",
            None,
            None,
            None,
            true,
            None,
            None,
        )
        .unwrap_err();
        assert_eq!(
            error,
            "App Update admission gate is closed outside development"
        );
    }
}

fn validate_download_url(value: &str) -> Result<String, String> {
    let mut url = reqwest::Url::parse(value)
        .map_err(|error| format!("invalid download base URL: {error}"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(
            "download base URL must be an HTTP(S) origin without credentials, query, or fragment"
                .to_owned(),
        );
    }
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_owned())
}

fn validate_label(name: &str, value: String) -> Result<String, String> {
    if value.is_empty() || value.len() > 200 || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(format!(
            "{name} must contain 1 to 200 visible ASCII characters"
        ));
    }
    Ok(value)
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
