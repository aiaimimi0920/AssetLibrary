use assetlibrary_contracts::{PackageKind, PublishedPackage, SearchPackageDocument};
use async_trait::async_trait;
use redis::AsyncCommands;
use reqwest::{Client, Url};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::time::{Duration, Instant};

use crate::config::SearchConfig;

const CACHE_OPERATION_TIMEOUT: Duration = Duration::from_millis(75);

#[derive(Clone, Debug, Serialize)]
pub struct SearchFilter {
    pub query: Option<String>,
    pub kind: Option<PackageKind>,
    pub tag: Option<String>,
    pub cursor: Option<Vec<Value>>,
    pub limit: u16,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SearchResult {
    pub items: Vec<PublishedPackage>,
    pub next_cursor: Option<Vec<Value>>,
}

#[derive(Debug)]
pub enum SearchError {
    Unavailable,
    InvalidProjection,
    InvalidCursor,
}

#[async_trait]
pub trait SearchRepository: Send + Sync {
    async fn search(&self, filter: &SearchFilter) -> Result<SearchResult, SearchError>;
}

pub struct OpenSearchRepository {
    client: Client,
    base: Url,
    username: String,
    password: String,
    alias: String,
    cache: redis::Client,
}

impl OpenSearchRepository {
    pub fn new(config: SearchConfig) -> Result<Self, String> {
        let client = Client::builder()
            .timeout(std::time::Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .danger_accept_invalid_certs(config.allow_invalid_certs)
            .no_proxy()
            .build()
            .map_err(|_| "failed to build OpenSearch client".to_owned())?;
        let cache = redis::Client::open(config.valkey_url)
            .map_err(|_| "failed to build Valkey client".to_owned())?;
        Ok(Self {
            client,
            base: config.opensearch_url,
            username: config.opensearch_username,
            password: config.opensearch_password,
            alias: config.alias,
            cache,
        })
    }

    async fn cached(&self, key: &str) -> Option<SearchResult> {
        let started = Instant::now();
        let Ok(Ok(mut connection)) = tokio::time::timeout(
            CACHE_OPERATION_TIMEOUT,
            self.cache.get_multiplexed_async_connection(),
        )
        .await
        else {
            assetlibrary_telemetry::record_cache("search_results", "error", started.elapsed());
            return None;
        };
        let Ok(Ok(value)) = tokio::time::timeout(
            CACHE_OPERATION_TIMEOUT,
            connection.get::<_, Option<String>>(key),
        )
        .await
        else {
            assetlibrary_telemetry::record_cache("search_results", "error", started.elapsed());
            return None;
        };
        let (outcome, result) = match value {
            Some(body) => match serde_json::from_str(&body) {
                Ok(result) => ("hit", Some(result)),
                Err(_) => ("error", None),
            },
            None => ("miss", None),
        };
        assetlibrary_telemetry::record_cache("search_results", outcome, started.elapsed());
        result
    }

    async fn cache(&self, key: &str, result: &SearchResult, ttl: u64) {
        let started = Instant::now();
        let Ok(Ok(mut connection)) = tokio::time::timeout(
            CACHE_OPERATION_TIMEOUT,
            self.cache.get_multiplexed_async_connection(),
        )
        .await
        else {
            assetlibrary_telemetry::record_dependency(
                "valkey",
                "search_cache_write",
                "error",
                started.elapsed(),
            );
            return;
        };
        let Ok(body) = serde_json::to_string(result) else {
            return;
        };
        let outcome = match tokio::time::timeout(
            CACHE_OPERATION_TIMEOUT,
            connection.set_ex::<_, _, ()>(key, body, ttl),
        )
        .await
        {
            Ok(Ok(())) => "success",
            _ => "error",
        };
        assetlibrary_telemetry::record_dependency(
            "valkey",
            "search_cache_write",
            outcome,
            started.elapsed(),
        );
    }

    async fn generation(&self) -> i64 {
        let started = Instant::now();
        let Ok(Ok(mut connection)) = tokio::time::timeout(
            CACHE_OPERATION_TIMEOUT,
            self.cache.get_multiplexed_async_connection(),
        )
        .await
        else {
            assetlibrary_telemetry::record_dependency(
                "valkey",
                "catalog_generation_read",
                "error",
                started.elapsed(),
            );
            return 0;
        };
        let result = tokio::time::timeout(
            CACHE_OPERATION_TIMEOUT,
            connection.get::<_, Option<i64>>("assetlibrary:catalog:generation"),
        )
        .await;
        let (outcome, generation) = match result {
            Ok(Ok(value)) => ("success", value.unwrap_or(0)),
            _ => ("error", 0),
        };
        assetlibrary_telemetry::record_dependency(
            "valkey",
            "catalog_generation_read",
            outcome,
            started.elapsed(),
        );
        generation
    }

    fn search_url(&self) -> Result<Url, SearchError> {
        let mut url = self.base.clone();
        let mut path = url
            .path_segments_mut()
            .map_err(|_| SearchError::Unavailable)?;
        path.clear();
        path.extend([self.alias.as_str(), "_search"]);
        drop(path);
        Ok(url)
    }
}

#[derive(Deserialize)]
struct SearchResponse {
    hits: SearchHits,
}

#[derive(Deserialize)]
struct SearchHits {
    hits: Vec<SearchHit>,
}

#[derive(Deserialize)]
struct SearchHit {
    #[serde(rename = "_source")]
    source: SearchPackageDocument,
    sort: Vec<Value>,
}

#[async_trait]
impl SearchRepository for OpenSearchRepository {
    async fn search(&self, filter: &SearchFilter) -> Result<SearchResult, SearchError> {
        let generation = self.generation().await;
        let serialized = serde_json::to_vec(filter).map_err(|_| SearchError::InvalidProjection)?;
        let digest = Sha256::digest(&serialized);
        let key = format!(
            "assetlibrary:catalog:search:{generation}:{}",
            hex::encode(digest)
        );
        if let Some(cached) = self.cached(&key).await {
            return Ok(cached);
        }
        let mut filters = Vec::new();
        if let Some(kind) = filter.kind.as_ref() {
            filters.push(json!({"term":{"package.kind":kind_text(kind)}}));
        }
        if let Some(tag) = filter.tag.as_ref() {
            filters.push(json!({"term":{"tags":tag}}));
        }
        let must = filter.query.as_ref().map_or_else(
            || json!({"match_all":{}}),
            |query| json!({"multi_match":{"query":query,"fields":["package.name^4","package.summary^2","description","package.publisher.display_name^2"]}}),
        );
        let mut body = json!({
            "size":usize::from(filter.limit.clamp(1,100))+1,
            "track_scores":true,
            "query":{"bool":{"must":[must],"filter":filters}},
            "sort":[{"_score":"desc"},{"updated_at":"desc"},{"package.id":"asc"}]
        });
        if let Some(cursor) = filter.cursor.as_ref() {
            body["search_after"] = json!(cursor);
        }
        let mut trace_headers = reqwest::header::HeaderMap::new();
        assetlibrary_telemetry::inject_current_context(&mut trace_headers);
        let started = Instant::now();
        let response = self
            .client
            .post(self.search_url()?)
            .basic_auth(&self.username, Some(&self.password))
            .headers(trace_headers)
            .json(&body)
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            Err(_) => {
                assetlibrary_telemetry::record_dependency(
                    "opensearch",
                    "catalog_search",
                    "transport_error",
                    started.elapsed(),
                );
                return Err(SearchError::Unavailable);
            }
        };
        if response.status() == reqwest::StatusCode::BAD_REQUEST && filter.cursor.is_some() {
            assetlibrary_telemetry::record_dependency(
                "opensearch",
                "catalog_search",
                "invalid_cursor",
                started.elapsed(),
            );
            return Err(SearchError::InvalidCursor);
        }
        if !response.status().is_success() {
            assetlibrary_telemetry::record_dependency(
                "opensearch",
                "catalog_search",
                "http_error",
                started.elapsed(),
            );
            return Err(SearchError::Unavailable);
        }
        let parsed = response.json::<SearchResponse>().await;
        let mut hits = match parsed {
            Ok(response) => response.hits.hits,
            Err(_) => {
                assetlibrary_telemetry::record_dependency(
                    "opensearch",
                    "catalog_search",
                    "invalid_response",
                    started.elapsed(),
                );
                return Err(SearchError::InvalidProjection);
            }
        };
        if hits.iter().any(|hit| !hit.source.validate()) {
            assetlibrary_telemetry::record_dependency(
                "opensearch",
                "catalog_search",
                "invalid_response",
                started.elapsed(),
            );
            return Err(SearchError::InvalidProjection);
        }
        assetlibrary_telemetry::record_dependency(
            "opensearch",
            "catalog_search",
            "success",
            started.elapsed(),
        );
        let has_more = hits.len() > usize::from(filter.limit.clamp(1, 100));
        hits.truncate(usize::from(filter.limit.clamp(1, 100)));
        let next_cursor = has_more
            .then(|| hits.last().map(|hit| hit.sort.clone()))
            .flatten();
        let result = SearchResult {
            items: hits.into_iter().map(|hit| hit.source.package).collect(),
            next_cursor,
        };
        self.cache(&key, &result, 60 + u64::from(digest[0] % 31))
            .await;
        Ok(result)
    }
}

#[derive(Default)]
pub struct UnavailableSearchRepository;

#[async_trait]
impl SearchRepository for UnavailableSearchRepository {
    async fn search(&self, _: &SearchFilter) -> Result<SearchResult, SearchError> {
        Err(SearchError::Unavailable)
    }
}

fn kind_text(kind: &PackageKind) -> &'static str {
    match kind {
        PackageKind::Art => "art",
        PackageKind::Capability => "capability",
        PackageKind::AppUpdate => "app_update",
    }
}
