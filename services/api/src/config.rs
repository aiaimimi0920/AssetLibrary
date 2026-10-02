use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use std::{env, fmt, net::SocketAddr};

#[path = "search_config.rs"]
mod search_config;
pub use search_config::{SearchConfig, SearchProvider};
#[cfg(test)]
#[path = "search_config_tests.rs"]
mod tests;

#[derive(Clone, Debug)]
pub struct Config {
    pub environment: Environment,
    pub bind: SocketAddr,
    pub database_url: Option<String>,
    pub oidc: Option<OidcConfig>,
    pub object_store: Option<ObjectStoreConfig>,
    pub app_updates_enabled: bool,
    pub downloads: Option<DownloadConfig>,
    pub search_provider: SearchProvider,
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

impl Config {
    pub fn from_env() -> Result<Self, String> {
        Self::from_lookup(|name| env::var(name).ok())
    }

    fn from_lookup(get: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let search_provider = SearchProvider::from_value(get("ASSETLIBRARY_SEARCH_PROVIDER"))?;
        let oidc_values = (
            get("ASSETLIBRARY_OIDC_ISSUER"),
            get("ASSETLIBRARY_OIDC_AUDIENCE"),
            get("ASSETLIBRARY_OIDC_JWKS_URL"),
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
            get("ASSETLIBRARY_S3_REGION"),
            get("ASSETLIBRARY_QUARANTINE_BUCKET"),
            get("ASSETLIBRARY_PUBLISHED_BUCKET"),
        );
        let object_store = match object_store_values {
            (Some(region), Some(quarantine_bucket), Some(published_bucket)) => {
                Some(ObjectStoreConfig {
                    endpoint_url: get("ASSETLIBRARY_S3_ENDPOINT"),
                    region,
                    quarantine_bucket,
                    published_bucket,
                    force_path_style: get("ASSETLIBRARY_S3_FORCE_PATH_STYLE")
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
            get("ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL"),
            get("ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL"),
            get("ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER"),
            get("ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE"),
            get("ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64"),
        );
        let downloads = match download_values {
            (Some(public), Some(restricted), Some(issuer), Some(audience), Some(secret)) => {
                let secret = URL_SAFE_NO_PAD
                    .decode(secret)
                    .map_err(|_| "download ticket secret must be unpadded base64url".to_owned())?;
                let ttl = get("ASSETLIBRARY_DOWNLOAD_TICKET_TTL_SECONDS")
                    .unwrap_or_else(|| "300".to_owned())
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
        let search = SearchConfig::from_lookup(search_provider, &get)?;
        let app_updates_enabled =
            get("ASSETLIBRARY_APP_UPDATES_ENABLED").is_some_and(|value| value == "true");
        let environment = match get("ASSETLIBRARY_ENVIRONMENT")
            .as_deref()
            .unwrap_or("development")
        {
            "development" => Environment::Development,
            "staging" => Environment::Staging,
            "production" => Environment::Production,
            value => return Err(format!("unsupported ASSETLIBRARY_ENVIRONMENT: {value}")),
        };
        if environment != Environment::Development && app_updates_enabled {
            return Err("App Update admission gate is closed outside development".to_owned());
        }
        let bind = get("ASSETLIBRARY_BIND")
            .unwrap_or_else(|| "127.0.0.1:8080".to_owned())
            .parse()
            .map_err(|error| format!("invalid ASSETLIBRARY_BIND: {error}"))?;
        let database_url = get("DATABASE_URL").filter(|value| !value.is_empty());
        if environment != Environment::Development && database_url.is_none() {
            return Err("DATABASE_URL is required outside development".to_owned());
        }
        if search_provider == SearchProvider::Postgres && database_url.is_none() {
            return Err("DATABASE_URL is required for PostgreSQL search".to_owned());
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
        if environment != Environment::Development
            && search_provider == SearchProvider::OpenSearch
            && search.is_none()
        {
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
            search.validate(environment)?;
        }
        Ok(Self {
            environment,
            bind,
            database_url,
            oidc,
            object_store,
            app_updates_enabled,
            downloads,
            search_provider,
            search,
        })
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
