use super::{Config, Environment, SearchProvider};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use std::collections::BTreeMap;

type Settings = BTreeMap<String, String>;

fn read(settings: &Settings) -> Result<Config, String> {
    Config::from_lookup(|name| settings.get(name).cloned())
}

fn set(settings: &mut Settings, name: &str, value: &str) {
    settings.insert(name.to_owned(), value.to_owned());
}

fn nondevelopment_settings(environment: &str) -> Settings {
    let mut settings: Settings = [
        ("ASSETLIBRARY_ENVIRONMENT", environment),
        ("DATABASE_URL", "postgres://database"),
        ("ASSETLIBRARY_OIDC_ISSUER", "https://accounts.example.test"),
        ("ASSETLIBRARY_OIDC_AUDIENCE", "assetlibrary"),
        (
            "ASSETLIBRARY_OIDC_JWKS_URL",
            "https://accounts.example.test/jwks",
        ),
        ("ASSETLIBRARY_S3_REGION", "us-east-1"),
        ("ASSETLIBRARY_QUARANTINE_BUCKET", "quarantine"),
        ("ASSETLIBRARY_PUBLISHED_BUCKET", "published"),
        (
            "ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL",
            "https://public.example.test",
        ),
        (
            "ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL",
            "https://restricted.example.test",
        ),
        ("ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER", "assetlibrary"),
        ("ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE", "edge"),
    ]
    .into_iter()
    .map(|(name, value)| (name.to_owned(), value.to_owned()))
    .collect();
    set(
        &mut settings,
        "ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64",
        &URL_SAFE_NO_PAD.encode([7_u8; 32]),
    );
    settings
}

fn add_opensearch(settings: &mut Settings) {
    for (name, value) in [
        ("ASSETLIBRARY_OPENSEARCH_URL", "https://search.example.test"),
        ("ASSETLIBRARY_OPENSEARCH_USERNAME", "search-reader"),
        ("ASSETLIBRARY_OPENSEARCH_PASSWORD", "test-only-password"),
        ("ASSETLIBRARY_VALKEY_URL", "rediss://cache.example.test"),
    ] {
        set(settings, name, value);
    }
}

#[test]
fn development_defaults_to_opensearch_without_external_services() {
    let config = read(&Settings::new()).unwrap();
    assert_eq!(config.environment, Environment::Development);
    assert_eq!(config.search_provider, SearchProvider::OpenSearch);
    assert_eq!(config.bind.to_string(), "127.0.0.1:8080");
    assert!(config.search.is_none());
    assert!(config.database_url.is_none());
    assert!(config.oidc.is_none());
    assert!(!config.app_updates_enabled);
}

#[test]
fn development_accepts_postgres_with_a_database() {
    let settings = Settings::from([
        ("ASSETLIBRARY_SEARCH_PROVIDER".into(), "postgres".into()),
        ("DATABASE_URL".into(), "postgres://database".into()),
    ]);
    let config = read(&settings).unwrap();
    assert_eq!(config.search_provider, SearchProvider::Postgres);
    assert_eq!(config.database_url.as_deref(), Some("postgres://database"));
    assert!(config.search.is_none());
}

#[test]
fn postgres_requires_a_nonempty_database_url_in_development() {
    let mut settings = Settings::new();
    set(&mut settings, "ASSETLIBRARY_SEARCH_PROVIDER", "postgres");
    for database in [None, Some("")] {
        if let Some(database) = database {
            set(&mut settings, "DATABASE_URL", database);
        }
        assert_eq!(
            read(&settings).unwrap_err(),
            "DATABASE_URL is required for PostgreSQL search"
        );
    }
}

#[test]
fn invalid_provider_names_are_rejected() {
    for name in ["", "Postgres", "postgresql", "postgres ", "unknown"] {
        let mut settings = Settings::new();
        set(&mut settings, "ASSETLIBRARY_SEARCH_PROVIDER", name);
        assert_eq!(
            read(&settings).unwrap_err(),
            format!("unsupported ASSETLIBRARY_SEARCH_PROVIDER: {name}")
        );
    }
}

#[test]
fn postgres_does_not_read_unused_search_settings() {
    let config = Config::from_lookup(|name| match name {
        "ASSETLIBRARY_SEARCH_PROVIDER" => Some("postgres".into()),
        "DATABASE_URL" => Some("postgres://database".into()),
        name if name.starts_with("ASSETLIBRARY_OPENSEARCH_")
            || matches!(
                name,
                "ASSETLIBRARY_VALKEY_URL" | "ASSETLIBRARY_SEARCH_ALIAS"
            ) =>
        {
            panic!("PostgreSQL mode must ignore unused setting {name}")
        }
        _ => None,
    })
    .unwrap();
    assert!(config.search.is_none());
}

#[test]
fn nondevelopment_postgres_keeps_database_oidc_storage_and_download_requirements() {
    for environment in ["staging", "production"] {
        let mut settings = nondevelopment_settings(environment);
        set(&mut settings, "ASSETLIBRARY_SEARCH_PROVIDER", "postgres");
        let config = read(&settings).unwrap();
        assert_eq!(config.search_provider, SearchProvider::Postgres);
        assert!(config.search.is_none());
        for (keys, expected) in [
            (&["DATABASE_URL"][..], "DATABASE_URL"),
            (
                &[
                    "ASSETLIBRARY_OIDC_ISSUER",
                    "ASSETLIBRARY_OIDC_AUDIENCE",
                    "ASSETLIBRARY_OIDC_JWKS_URL",
                ][..],
                "OIDC configuration",
            ),
            (
                &[
                    "ASSETLIBRARY_S3_REGION",
                    "ASSETLIBRARY_QUARANTINE_BUCKET",
                    "ASSETLIBRARY_PUBLISHED_BUCKET",
                ][..],
                "object store configuration",
            ),
            (
                &[
                    "ASSETLIBRARY_PUBLIC_DOWNLOAD_BASE_URL",
                    "ASSETLIBRARY_RESTRICTED_DOWNLOAD_BASE_URL",
                    "ASSETLIBRARY_DOWNLOAD_TICKET_ISSUER",
                    "ASSETLIBRARY_DOWNLOAD_TICKET_AUDIENCE",
                    "ASSETLIBRARY_DOWNLOAD_TICKET_SECRET_BASE64",
                ][..],
                "download configuration",
            ),
        ] {
            let mut missing = settings.clone();
            for key in keys {
                missing.remove(*key);
            }
            assert_eq!(
                read(&missing).unwrap_err(),
                format!("{expected} is required outside development")
            );
        }
    }
}

#[test]
fn nondevelopment_opensearch_still_requires_search_configuration() {
    for environment in ["staging", "production"] {
        let mut settings = nondevelopment_settings(environment);
        assert_eq!(
            read(&settings).unwrap_err(),
            "search configuration is required outside development"
        );
        add_opensearch(&mut settings);
        for provider in [None, Some("opensearch")] {
            if let Some(provider) = provider {
                set(&mut settings, "ASSETLIBRARY_SEARCH_PROVIDER", provider);
            }
            let config = read(&settings).unwrap();
            assert_eq!(config.search_provider, SearchProvider::OpenSearch);
            assert_eq!(config.search.unwrap().alias, "assetlibrary-packages");
        }
    }
}

#[test]
fn nondevelopment_cannot_enable_app_updates_before_admission() {
    for provider in ["opensearch", "postgres"] {
        let mut settings = nondevelopment_settings("production");
        set(&mut settings, "ASSETLIBRARY_SEARCH_PROVIDER", provider);
        set(&mut settings, "ASSETLIBRARY_APP_UPDATES_ENABLED", "true");
        assert_eq!(
            read(&settings).unwrap_err(),
            "App Update admission gate is closed outside development"
        );
    }
}

#[test]
fn opensearch_retains_credentials_url_and_tls_validation() {
    let mut settings = nondevelopment_settings("production");
    add_opensearch(&mut settings);
    for (name, value, expected) in [
        (
            "ASSETLIBRARY_OPENSEARCH_USERNAME",
            "",
            "OpenSearch username must contain 1 to 200 visible ASCII characters",
        ),
        (
            "ASSETLIBRARY_OPENSEARCH_PASSWORD",
            "",
            "OpenSearch password has invalid length or characters",
        ),
        (
            "ASSETLIBRARY_OPENSEARCH_URL",
            "https://user:secret@search.example.test",
            "OpenSearch URL must be an HTTP(S) origin without credentials",
        ),
        (
            "ASSETLIBRARY_OPENSEARCH_URL",
            "http://search.example.test",
            "OpenSearch and Valkey must use TLS outside development",
        ),
        (
            "ASSETLIBRARY_VALKEY_URL",
            "redis://cache.example.test",
            "OpenSearch and Valkey must use TLS outside development",
        ),
        (
            "ASSETLIBRARY_VALKEY_URL",
            "https://cache.example.test",
            "Valkey URL must use redis or rediss",
        ),
        (
            "ASSETLIBRARY_SEARCH_ALIAS",
            "bad/alias",
            "search alias contains unsupported characters",
        ),
        (
            "ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS",
            "true",
            "invalid OpenSearch certificates may be accepted only on loopback",
        ),
    ] {
        let mut invalid = settings.clone();
        set(&mut invalid, name, value);
        assert_eq!(read(&invalid).unwrap_err(), expected);
    }
    settings.remove("ASSETLIBRARY_OPENSEARCH_PASSWORD");
    assert_eq!(
        read(&settings).unwrap_err(),
        "OpenSearch credentials and Valkey URL must be configured together"
    );
}

#[test]
fn opensearch_loopback_certificate_exception_is_preserved() {
    let mut settings = Settings::new();
    add_opensearch(&mut settings);
    set(
        &mut settings,
        "ASSETLIBRARY_OPENSEARCH_URL",
        "https://127.0.0.1:9200",
    );
    set(
        &mut settings,
        "ASSETLIBRARY_OPENSEARCH_ALLOW_INVALID_CERTS",
        "true",
    );
    assert!(read(&settings).unwrap().search.unwrap().allow_invalid_certs);
}
