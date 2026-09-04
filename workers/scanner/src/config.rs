use assetlibrary_object_store::ObjectStoreConfig;
use std::{env, net::SocketAddr, path::PathBuf, time::Duration};

pub struct Config {
    pub database_url: String,
    pub nats_url: String,
    pub object_store: ObjectStoreConfig,
    pub clamav_address: Option<SocketAddr>,
    pub temporary_root: PathBuf,
    pub scan_timeout: Duration,
    pub consumer_name: String,
    pub deliver_new_only: bool,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let environment =
            env::var("ASSETLIBRARY_ENVIRONMENT").unwrap_or_else(|_| "development".to_owned());
        let database_url = required("DATABASE_URL")?;
        let nats_url = required("ASSETLIBRARY_NATS_URL")?;
        let endpoint_url = env::var("ASSETLIBRARY_S3_ENDPOINT").ok();
        if environment != "development"
            && (!nats_url.starts_with("tls://")
                || endpoint_url
                    .as_deref()
                    .is_some_and(|endpoint| !endpoint.starts_with("https://")))
        {
            return Err("scanner dependencies must use TLS outside development".to_owned());
        }
        let clamav_address = env::var("ASSETLIBRARY_CLAMAV_ADDRESS")
            .ok()
            .map(|value| {
                value
                    .parse::<SocketAddr>()
                    .map_err(|_| "invalid ASSETLIBRARY_CLAMAV_ADDRESS".to_owned())
            })
            .transpose()?;
        if environment != "development"
            && clamav_address.is_some_and(|address| !address.ip().is_loopback())
        {
            return Err("ClamAV must be a loopback sidecar outside development".to_owned());
        }
        let timeout_seconds = env::var("ASSETLIBRARY_SCAN_TIMEOUT_SECONDS")
            .ok()
            .map(|value| value.parse::<u64>())
            .transpose()
            .map_err(|_| "invalid ASSETLIBRARY_SCAN_TIMEOUT_SECONDS".to_owned())?
            .unwrap_or(120);
        if !(10..=900).contains(&timeout_seconds) {
            return Err("scanner timeout must be between 10 and 900 seconds".to_owned());
        }
        let consumer_name = env::var("ASSETLIBRARY_SCANNER_CONSUMER")
            .unwrap_or_else(|_| "assetlibrary-scanner-v1".to_owned());
        if consumer_name.is_empty()
            || consumer_name.len() > 100
            || !consumer_name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err("invalid ASSETLIBRARY_SCANNER_CONSUMER".to_owned());
        }
        let deliver_new_only =
            env::var("ASSETLIBRARY_SCANNER_DELIVER_POLICY").is_ok_and(|value| value == "new");
        if environment != "development" && deliver_new_only {
            return Err("new-only scanner delivery is development-only".to_owned());
        }
        Ok(Self {
            database_url,
            nats_url,
            object_store: ObjectStoreConfig {
                endpoint_url,
                region: required("ASSETLIBRARY_S3_REGION")?,
                quarantine_bucket: required("ASSETLIBRARY_QUARANTINE_BUCKET")?,
                published_bucket: required("ASSETLIBRARY_PUBLISHED_BUCKET")?,
                force_path_style: env::var("ASSETLIBRARY_S3_FORCE_PATH_STYLE")
                    .is_ok_and(|value| value == "true"),
            },
            clamav_address,
            temporary_root: env::var_os("ASSETLIBRARY_SCANNER_TEMP_ROOT")
                .map(PathBuf::from)
                .unwrap_or_else(env::temp_dir),
            scan_timeout: Duration::from_secs(timeout_seconds),
            consumer_name,
            deliver_new_only,
        })
    }
}

fn required(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}
