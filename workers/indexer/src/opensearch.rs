use assetlibrary_contracts::SearchPackageDocument;
use reqwest::{Client, StatusCode, Url};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

use crate::config::Config;

/// Document reads and writes are small and retried by the JetStream consumer,
/// so they keep a short deadline.
const DOCUMENT_TIMEOUT: Duration = Duration::from_secs(10);
/// Index creation, alias moves, refreshes, and index deletes are serialized
/// cluster-state updates that take tens of seconds on a small single node.
const INDEX_MANAGEMENT_TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Clone)]
pub struct OpenSearch {
    client: Client,
    base: Url,
    username: String,
    password: String,
    pub alias: String,
    prefix: String,
    management_timeout: Duration,
}

impl OpenSearch {
    pub fn new(config: &Config) -> Result<Self, reqwest::Error> {
        Self::with_timeouts(config, DOCUMENT_TIMEOUT, INDEX_MANAGEMENT_TIMEOUT)
    }

    pub(crate) fn with_timeouts(
        config: &Config,
        document_timeout: Duration,
        management_timeout: Duration,
    ) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .timeout(document_timeout)
                .redirect(reqwest::redirect::Policy::none())
                .no_proxy()
                .danger_accept_invalid_certs(config.opensearch_allow_invalid_certs)
                .build()?,
            base: config.opensearch_url.clone(),
            username: config.opensearch_username.clone(),
            password: config.opensearch_password.clone(),
            alias: config.alias.clone(),
            prefix: config.index_prefix.clone(),
            management_timeout,
        })
    }

    pub async fn ensure_live_index(&self) -> Result<(), String> {
        if !self.alias_targets().await?.is_empty() {
            return Ok(());
        }
        let index = self.versioned_index();
        self.create_index(&index).await?;
        self.swap_alias(&index).await
    }

    pub async fn create_rebuild_index(&self) -> Result<String, String> {
        let index = self.versioned_index();
        self.create_index(&index).await?;
        Ok(index)
    }

    pub async fn upsert(
        &self,
        index: &str,
        document: &SearchPackageDocument,
    ) -> Result<(), String> {
        self.upsert_document(index, document, true).await
    }

    pub async fn upsert_for_rebuild(
        &self,
        index: &str,
        document: &SearchPackageDocument,
    ) -> Result<(), String> {
        self.upsert_document(index, document, false).await
    }

    async fn upsert_document(
        &self,
        index: &str,
        document: &SearchPackageDocument,
        refresh: bool,
    ) -> Result<(), String> {
        let mut url = self.url(&[index, "_doc", &document.package.id.to_string()])?;
        if refresh {
            url.query_pairs_mut().append_pair("refresh", "wait_for");
        }
        let request = self.client.put(url);
        let response = self
            .auth(request)
            .json(document)
            .send()
            .await
            .map_err(|_| "OpenSearch upsert request failed".to_owned())?;
        require_success(response.status(), "OpenSearch upsert")
    }

    pub async fn delete(&self, index: &str, package_id: Uuid) -> Result<(), String> {
        let mut url = self.url(&[index, "_doc", &package_id.to_string()])?;
        url.query_pairs_mut().append_pair("refresh", "wait_for");
        let response = self
            .auth(self.client.delete(url))
            .send()
            .await
            .map_err(|_| "OpenSearch delete request failed".to_owned())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        require_success(response.status(), "OpenSearch delete")
    }

    pub async fn swap_alias(&self, next: &str) -> Result<(), String> {
        let current = self.alias_targets().await?;
        let mut actions = current
            .into_iter()
            .map(|index| json!({"remove":{"index":index,"alias":self.alias}}))
            .collect::<Vec<_>>();
        actions.push(json!({"add":{"index":next,"alias":self.alias,"is_write_index":true}}));
        let response = self
            .auth(self.client.post(self.url(&["_aliases"])?))
            .timeout(self.management_timeout)
            .json(&json!({"actions":actions}))
            .send()
            .await
            .map_err(|_| "OpenSearch alias swap request failed".to_owned())?;
        require_success(response.status(), "OpenSearch alias swap")
    }

    pub async fn refresh(&self, index: &str) -> Result<(), String> {
        let response = self
            .auth(self.client.post(self.url(&[index, "_refresh"])?))
            .timeout(self.management_timeout)
            .send()
            .await
            .map_err(|_| "OpenSearch refresh request failed".to_owned())?;
        require_success(response.status(), "OpenSearch refresh")
    }

    pub async fn delete_if_unaliased(&self, index: &str) -> Result<(), String> {
        if self
            .alias_targets()
            .await?
            .iter()
            .any(|value| value == index)
        {
            return Ok(());
        }
        let response = self
            .auth(self.client.delete(self.url(&[index])?))
            .timeout(self.management_timeout)
            .send()
            .await
            .map_err(|_| "OpenSearch rebuild-index cleanup failed".to_owned())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        require_success(response.status(), "OpenSearch rebuild-index cleanup")
    }

    async fn create_index(&self, index: &str) -> Result<(), String> {
        let request = self
            .auth(self.client.put(self.url(&[index])?))
            .timeout(self.management_timeout)
            .json(&index_definition());
        let response = match request.send().await {
            Ok(response) => response,
            Err(error) => {
                // The node may still finish the creation after the client gave
                // up; remove it so a restart does not leave an orphan behind.
                self.discard_index(index).await;
                return Err(format!("OpenSearch index creation failed: {error}"));
            }
        };
        let status = response.status();
        if status.is_success() {
            return Ok(());
        }
        let detail = response.text().await.unwrap_or_default();
        Err(format!(
            "OpenSearch index creation returned {status}: {}",
            detail.chars().take(500).collect::<String>()
        ))
    }

    async fn discard_index(&self, index: &str) {
        let Ok(url) = self.url(&[index]) else {
            return;
        };
        let _ = self
            .auth(self.client.delete(url))
            .timeout(self.management_timeout)
            .send()
            .await;
    }

    async fn alias_targets(&self) -> Result<Vec<String>, String> {
        let response = self
            .auth(self.client.get(self.url(&["_alias", &self.alias])?))
            .send()
            .await
            .map_err(|_| "OpenSearch alias lookup failed".to_owned())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(Vec::new());
        }
        if !response.status().is_success() {
            return Err(format!(
                "OpenSearch alias lookup returned {}",
                response.status()
            ));
        }
        let body = response
            .json::<serde_json::Map<String, Value>>()
            .await
            .map_err(|_| "OpenSearch alias response was invalid".to_owned())?;
        Ok(body.into_iter().map(|(index, _)| index).collect())
    }

    fn versioned_index(&self) -> String {
        format!(
            "{}-{}-{}",
            self.prefix,
            time::OffsetDateTime::now_utc().unix_timestamp(),
            &Uuid::new_v4().simple().to_string()[..8]
        )
    }

    fn auth(&self, request: reqwest::RequestBuilder) -> reqwest::RequestBuilder {
        request.basic_auth(&self.username, Some(&self.password))
    }

    fn url(&self, segments: &[&str]) -> Result<Url, String> {
        let mut url = self.base.clone();
        url.set_query(None);
        url.set_fragment(None);
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "OpenSearch URL cannot be a base".to_owned())?;
        path.clear();
        path.extend(segments);
        drop(path);
        Ok(url)
    }
}

fn require_success(status: StatusCode, operation: &str) -> Result<(), String> {
    if status.is_success() {
        Ok(())
    } else {
        Err(format!("{operation} returned {status}"))
    }
}

fn index_definition() -> Value {
    json!({
        "settings":{"index":{"number_of_shards":3,"number_of_replicas":1}},
        "mappings":{"dynamic":"strict","properties":{
            "schema_version":{"type":"keyword"},
            "package":{"properties":{
                "id":{"type":"keyword"},"slug":{"type":"keyword"},"name":{"type":"text","fields":{"keyword":{"type":"keyword"}}},
                "kind":{"type":"keyword"},"status":{"type":"keyword"},"summary":{"type":"text"},
                "publisher":{"properties":{"id":{"type":"keyword"},"slug":{"type":"keyword"},"display_name":{"type":"text","fields":{"keyword":{"type":"keyword"}}}}}
            }},
            "description":{"type":"text"},"tags":{"type":"keyword"},"release_id":{"type":"keyword"},
            "version":{"type":"keyword"},"artifact_id":{"type":"keyword"},"signing_key_id":{"type":"keyword"},"digest":{"type":"keyword"},
            "size_bytes":{"type":"long"},"media_type":{"type":"keyword"},"file_name":{"type":"keyword"},
            "updated_at":{"type":"date"}
        }}
    })
}

#[cfg(test)]
mod tests {
    use super::index_definition;

    #[test]
    fn mapping_is_strict_and_indexes_tags() {
        let mapping = index_definition();
        assert_eq!(
            mapping
                .pointer("/mappings/dynamic")
                .and_then(|v| v.as_str()),
            Some("strict")
        );
        assert_eq!(
            mapping
                .pointer("/mappings/properties/tags/type")
                .and_then(|v| v.as_str()),
            Some("keyword")
        );
    }
}
