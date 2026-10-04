use super::{Config, mode::IndexerMode};
use std::{cell::RefCell, collections::BTreeMap};

fn base() -> BTreeMap<&'static str, String> {
    BTreeMap::from([
        (
            "DATABASE_URL",
            "postgres://secret@127.0.0.1/test".to_owned(),
        ),
        ("NATS_URL", "nats://127.0.0.1:4222".to_owned()),
    ])
}

fn edge() -> BTreeMap<&'static str, String> {
    let mut values = base();
    values.extend([
        ("ASSETLIBRARY_INDEXER_MODE", "edge-policy".to_owned()),
        ("ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID", "a".repeat(32)),
        ("ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID", "b".repeat(32)),
        (
            "ASSETLIBRARY_EDGE_POLICY_API_TOKEN",
            "edge-secret".repeat(3),
        ),
    ]);
    values
}

fn search() -> BTreeMap<&'static str, String> {
    let mut values = base();
    values.extend([
        (
            "ASSETLIBRARY_VALKEY_URL",
            "redis://127.0.0.1:6379".to_owned(),
        ),
        (
            "ASSETLIBRARY_OPENSEARCH_URL",
            "http://127.0.0.1:9200".to_owned(),
        ),
        ("ASSETLIBRARY_OPENSEARCH_USERNAME", "admin".to_owned()),
        (
            "ASSETLIBRARY_OPENSEARCH_PASSWORD",
            "search-secret".to_owned(),
        ),
    ]);
    values
}

fn load(values: &BTreeMap<&str, String>) -> Result<Config, String> {
    Config::from_lookup(|name| values.get(name).cloned())
}

#[test]
fn old_default_requires_search_and_preserves_names() {
    assert!(
        load(&base())
            .unwrap_err()
            .contains("ASSETLIBRARY_OPENSEARCH_URL")
    );
    let config = load(&search()).unwrap();
    assert_eq!(config.mode, IndexerMode::SearchEdge);
    assert_eq!(config.consumer_name, "assetlibrary-indexer-v1");
    assert_eq!(config.mode.projection(), "search-edge-v1");
    let settings = config.search.unwrap();
    assert_eq!(settings.alias, "assetlibrary-packages");
    assert_eq!(settings.index_prefix, "assetlibrary-packages-v1");
}

#[test]
fn edge_only_never_reads_search_configuration() {
    let values = edge();
    let reads = RefCell::new(Vec::new());
    let config = Config::from_lookup(|name| {
        reads.borrow_mut().push(name.to_owned());
        values.get(name).cloned()
    })
    .unwrap();
    assert!(config.search.is_none());
    assert!(config.edge_policy.is_some());
    assert_eq!(config.mode.projection(), "edge-policy-v1");
    assert_eq!(
        config.consumer_name,
        "assetlibrary-indexer-v1-edge-policy-v1"
    );
    assert!(
        reads
            .borrow()
            .iter()
            .all(|name| !name.contains("OPENSEARCH")
                && !name.contains("VALKEY")
                && !name.starts_with("ASSETLIBRARY_SEARCH_"))
    );
}

#[test]
fn edge_mode_requires_complete_valid_edge_configuration() {
    let mut values = base();
    values.insert("ASSETLIBRARY_INDEXER_MODE", "edge-policy".to_owned());
    assert!(
        load(&values)
            .unwrap_err()
            .contains("edge policy configuration is required")
    );
    for key in [
        "ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID",
        "ASSETLIBRARY_EDGE_POLICY_NAMESPACE_ID",
        "ASSETLIBRARY_EDGE_POLICY_API_TOKEN",
    ] {
        let mut values = edge();
        values.remove(key);
        assert!(load(&values).unwrap_err().contains("configured together"));
    }
    for (key, value) in [
        ("ASSETLIBRARY_EDGE_POLICY_ACCOUNT_ID", "invalid"),
        ("ASSETLIBRARY_EDGE_POLICY_API_TOKEN", "short"),
        (
            "ASSETLIBRARY_EDGE_POLICY_API_BASE",
            "http://secret@127.0.0.1",
        ),
    ] {
        let mut values = edge();
        values.insert(key, value.to_owned());
        assert!(load(&values).is_err());
    }
}

#[test]
fn modes_have_disjoint_durables_and_reject_invalid_names() {
    for base in ["assetlibrary-indexer-v1", "custom"] {
        let full = IndexerMode::SearchEdge.consumer(base.to_owned()).unwrap();
        let edge = IndexerMode::EdgePolicy.consumer(base.to_owned()).unwrap();
        assert_ne!(full, edge);
        assert!(IndexerMode::SearchEdge.consumer(edge).is_err());
    }
    for mode in [IndexerMode::SearchEdge, IndexerMode::EdgePolicy] {
        for name in ["", "a.b", "a/b", "space name", "reserved-edge-policy-v1"] {
            assert!(mode.consumer(name.to_owned()).is_err());
        }
    }
    assert!(IndexerMode::EdgePolicy.consumer("a".repeat(88)).is_err());
    assert!(IndexerMode::SearchEdge.consumer("a".repeat(100)).is_ok());
    assert!(IndexerMode::parse(Some("unknown".to_owned())).is_err());
}

#[test]
fn nondevelopment_keeps_tls_and_edge_requirements_without_unused_valkey() {
    let mut values = edge();
    values.insert("ASSETLIBRARY_ENVIRONMENT", "production".to_owned());
    assert_eq!(
        load(&values).unwrap_err(),
        "NATS must use TLS outside development"
    );
    values.insert("NATS_URL", "tls://nats.example:4222".to_owned());
    values.insert(
        "ASSETLIBRARY_EDGE_POLICY_API_BASE",
        "http://127.0.0.1".to_owned(),
    );
    assert_eq!(
        load(&values).unwrap_err(),
        "edge policy API must use HTTPS outside development"
    );
    values.remove("ASSETLIBRARY_EDGE_POLICY_API_BASE");
    assert!(load(&values).is_ok());
    values.insert("ASSETLIBRARY_INDEXER_MODE", "search-edge".to_owned());
    values.extend(
        search()
            .into_iter()
            .filter(|(key, _)| key.starts_with("ASSETLIBRARY_")),
    );
    assert_eq!(
        load(&values).unwrap_err(),
        "Valkey must use TLS outside development"
    );
    values.insert(
        "ASSETLIBRARY_VALKEY_URL",
        "rediss://valkey.example".to_owned(),
    );
    assert!(load(&values).is_ok());
}

#[test]
fn debug_does_not_expose_secrets_or_connection_strings() {
    let mut values = edge();
    values.insert("ASSETLIBRARY_INDEXER_MODE", "search-edge".to_owned());
    values.extend(search());
    let debug = format!("{:?}", load(&values).unwrap());
    for hidden in [
        "postgres://",
        "nats://",
        "redis://",
        "edge-secret",
        "search-secret",
    ] {
        assert!(!debug.contains(hidden));
    }
}
