//! Timeout behaviour of the OpenSearch client against a slow mock node.

use crate::config::Config;
use crate::opensearch::OpenSearch;
use axum::{
    Json, Router,
    extract::{Path, State},
    http::{Method, StatusCode},
    routing::{delete, get, post, put},
};
use serde_json::{Value, json};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};
use uuid::Uuid;

const SHORT: Duration = Duration::from_millis(100);
const LONG: Duration = Duration::from_secs(5);

struct Mock {
    delay: Duration,
    requests: Mutex<Vec<String>>,
}

impl Mock {
    fn record(&self, method: Method, path: String) {
        self.requests
            .lock()
            .unwrap()
            .push(format!("{method} {path}"));
    }

    fn requests(&self) -> Vec<String> {
        self.requests.lock().unwrap().clone()
    }
}

async fn alias_lookup(State(mock): State<Arc<Mock>>, Path(alias): Path<String>) -> StatusCode {
    mock.record(Method::GET, format!("/_alias/{alias}"));
    StatusCode::NOT_FOUND
}

async fn alias_swap(State(mock): State<Arc<Mock>>) -> Json<Value> {
    mock.record(Method::POST, "/_aliases".to_owned());
    Json(json!({"acknowledged": true}))
}

async fn slow_create(State(mock): State<Arc<Mock>>, Path(index): Path<String>) -> Json<Value> {
    mock.record(Method::PUT, format!("/{index}"));
    tokio::time::sleep(mock.delay).await;
    Json(json!({"acknowledged": true, "index": index}))
}

async fn delete_index(State(mock): State<Arc<Mock>>, Path(index): Path<String>) -> StatusCode {
    mock.record(Method::DELETE, format!("/{index}"));
    StatusCode::OK
}

async fn slow_delete_document(
    State(mock): State<Arc<Mock>>,
    Path((index, id)): Path<(String, String)>,
) -> StatusCode {
    mock.record(Method::DELETE, format!("/{index}/_doc/{id}"));
    tokio::time::sleep(mock.delay).await;
    StatusCode::OK
}

async fn start_mock(delay: Duration) -> (String, Arc<Mock>) {
    let mock = Arc::new(Mock {
        delay,
        requests: Mutex::new(Vec::new()),
    });
    let router = Router::new()
        .route("/_aliases", post(alias_swap))
        .route("/_alias/{alias}", get(alias_lookup))
        .route("/{index}", put(slow_create).delete(delete_index))
        .route("/{index}/_doc/{id}", delete(slow_delete_document))
        .with_state(mock.clone());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (base, mock)
}

fn client(base: &str, document_timeout: Duration, management_timeout: Duration) -> OpenSearch {
    let config = Config {
        database_url: String::new(),
        nats_url: String::new(),
        valkey_url: String::new(),
        opensearch_url: reqwest::Url::parse(base).unwrap(),
        opensearch_username: "admin".to_owned(),
        opensearch_password: "test-password".to_owned(),
        opensearch_allow_invalid_certs: false,
        index_prefix: "assetlibrary-packages-v1".to_owned(),
        alias: "assetlibrary-packages".to_owned(),
        consumer_name: "assetlibrary-indexer-v1".to_owned(),
        edge_policy: None,
    };
    OpenSearch::with_timeouts(&config, document_timeout, management_timeout).unwrap()
}

#[tokio::test]
async fn slow_index_creation_outlives_the_document_timeout() {
    let (base, mock) = start_mock(SHORT * 3).await;
    let search = client(&base, SHORT, LONG);
    search.ensure_live_index().await.unwrap();
    let requests = mock.requests();
    let created = requests
        .iter()
        .filter(|request| request.starts_with("PUT /assetlibrary-packages-v1-"))
        .count();
    assert_eq!(created, 1);
    assert!(requests.contains(&"POST /_aliases".to_owned()));
    assert!(
        requests
            .iter()
            .all(|request| !request.starts_with("DELETE "))
    );
}

#[tokio::test]
async fn document_operations_keep_the_short_timeout() {
    let (base, mock) = start_mock(SHORT * 3).await;
    let search = client(&base, SHORT, LONG);
    let error = search
        .delete("assetlibrary-packages", Uuid::new_v4())
        .await
        .unwrap_err();
    assert_eq!(error, "OpenSearch delete request failed");
    assert_eq!(mock.requests().len(), 1);
}

#[tokio::test]
async fn unconfirmed_index_creation_is_discarded() {
    let (base, mock) = start_mock(SHORT * 3).await;
    let search = client(&base, SHORT, SHORT);
    let error = search.ensure_live_index().await.unwrap_err();
    assert!(error.starts_with("OpenSearch index creation failed: "));
    let requests = mock.requests();
    let created = requests
        .iter()
        .find_map(|request| request.strip_prefix("PUT "))
        .unwrap()
        .to_owned();
    assert!(requests.contains(&format!("DELETE {created}")));
}
