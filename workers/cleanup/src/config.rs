use assetlibrary_object_store::ObjectStoreConfig;
use std::env;

pub struct Config {
    pub database_url: String,
    pub object_store: ObjectStoreConfig,
    pub batch_size: i64,
    pub claim_timeout_seconds: i64,
    pub terminal_retention_seconds: i64,
    pub orphan_grace_seconds: i64,
    pub orphan_scan_limit: i64,
    pub orphan_batch_size: i64,
}

impl Config {
    pub fn from_env() -> Result<Self, String> {
        let environment =
            env::var("ASSETLIBRARY_ENVIRONMENT").unwrap_or_else(|_| "development".to_owned());
        let endpoint_url = env::var("ASSETLIBRARY_S3_ENDPOINT").ok();
        if environment != "development"
            && endpoint_url
                .as_deref()
                .is_some_and(|endpoint| !endpoint.starts_with("https://"))
        {
            return Err("cleanup object storage must use TLS outside development".to_owned());
        }
        Ok(Self {
            database_url: required("DATABASE_URL")?,
            object_store: ObjectStoreConfig {
                endpoint_url,
                region: required("ASSETLIBRARY_S3_REGION")?,
                quarantine_bucket: required("ASSETLIBRARY_QUARANTINE_BUCKET")?,
                published_bucket: required("ASSETLIBRARY_PUBLISHED_BUCKET")?,
                force_path_style: env::var("ASSETLIBRARY_S3_FORCE_PATH_STYLE")
                    .is_ok_and(|value| value == "true"),
            },
            batch_size: bounded("ASSETLIBRARY_CLEANUP_BATCH_SIZE", 100, 1, 500)?,
            claim_timeout_seconds: bounded(
                "ASSETLIBRARY_CLEANUP_CLAIM_TIMEOUT_SECONDS",
                900,
                60,
                3600,
            )?,
            terminal_retention_seconds: bounded(
                "ASSETLIBRARY_QUARANTINE_RETENTION_SECONDS",
                2_592_000,
                86_400,
                31_536_000,
            )?,
            orphan_grace_seconds: bounded(
                "ASSETLIBRARY_ORPHAN_MULTIPART_GRACE_SECONDS",
                7_200,
                if environment == "development" {
                    1
                } else {
                    3_600
                },
                604_800,
            )?,
            orphan_scan_limit: bounded(
                "ASSETLIBRARY_ORPHAN_MULTIPART_SCAN_LIMIT",
                5_000,
                100,
                10_000,
            )?,
            orphan_batch_size: bounded("ASSETLIBRARY_ORPHAN_MULTIPART_BATCH_SIZE", 100, 1, 500)?,
        })
    }
}

fn required(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required"))
}

fn bounded(name: &str, default: i64, minimum: i64, maximum: i64) -> Result<i64, String> {
    let value = env::var(name)
        .ok()
        .map(|raw| raw.parse::<i64>())
        .transpose()
        .map_err(|_| format!("{name} must be an integer"))?
        .unwrap_or(default);
    if !(minimum..=maximum).contains(&value) {
        return Err(format!("{name} must be between {minimum} and {maximum}"));
    }
    Ok(value)
}
