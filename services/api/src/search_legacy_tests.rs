use super::*;
use time::OffsetDateTime;
use uuid::Uuid;

#[tokio::test]
async fn opensearch_rejects_postgres_cursor_before_dependency_access() {
    let repository = OpenSearchRepository::new(SearchConfig {
        opensearch_url: Url::parse("http://127.0.0.1:9").unwrap(),
        opensearch_username: "fixture".into(),
        opensearch_password: "fixture-only".into(),
        allow_invalid_certs: false,
        valkey_url: "redis://127.0.0.1:9".into(),
        alias: "fixture".into(),
    })
    .unwrap();
    let mut filter = SearchFilter {
        query: None,
        kind: None,
        tag: None,
        cursor: None,
        limit: 1,
    };
    filter.cursor = Some(
        crate::search_cursor::encode(&filter, OffsetDateTime::UNIX_EPOCH, Uuid::from_u128(1))
            .unwrap(),
    );
    assert!(matches!(
        repository.search(&filter).await,
        Err(SearchError::InvalidCursor)
    ));
}
