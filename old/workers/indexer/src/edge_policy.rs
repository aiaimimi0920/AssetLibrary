use assetlibrary_contracts::{PackageKind, SearchPackageDocument};
use reqwest::{Client, StatusCode, Url};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use uuid::Uuid;

use crate::{config::EdgePolicyConfig, repository::Repository};

#[derive(Clone)]
pub struct EdgePolicy {
    client: Client,
    base: Url,
    account_id: String,
    namespace_id: String,
    token: String,
}

#[derive(Deserialize)]
struct ApiResponse {
    success: bool,
}

impl EdgePolicy {
    pub fn new(config: EdgePolicyConfig) -> Result<Self, reqwest::Error> {
        Ok(Self {
            client: Client::builder()
                .timeout(std::time::Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()?,
            base: config.api_base,
            account_id: config.account_id,
            namespace_id: config.namespace_id,
            token: config.api_token,
        })
    }

    pub async fn reconcile(
        &self,
        repository: &Repository,
        package_id: Uuid,
        document: Option<&SearchPackageDocument>,
    ) -> Result<(), String> {
        let old = repository.edge_state(package_id).await.map_err(database)?;
        let desired_policy = document.and_then(public_policy);
        let desired_digest = desired_policy
            .as_ref()
            .and_then(|value| value.get("digest"))
            .and_then(Value::as_str);
        let desired_revocations = repository
            .active_revocations(package_id)
            .await
            .map_err(database)?
            .into_iter()
            .collect::<BTreeSet<_>>();
        let old_revocations = old.revocation_keys.into_iter().collect::<BTreeSet<_>>();

        // Signing-key revocation is irreversible. These monotonic deny keys are
        // paged separately, never added to the reversible blocklist snapshot
        // (which has a 1000-key bound), and never removed by reconciliation.
        let mut after = None;
        loop {
            let keys = repository
                .revoked_signing_keys(package_id, after.as_deref())
                .await
                .map_err(database)?;
            if keys.is_empty() {
                break;
            }
            for (key, publisher) in &keys {
                self.put(
                    &format!("revoked:signing_key:{publisher}:{key}"),
                    "1",
                    "text/plain",
                )
                .await?;
            }
            after = keys.last().map(|value| value.0.clone());
        }

        for key in desired_revocations.difference(&old_revocations) {
            self.put(key, "1", "text/plain").await?;
        }
        if old.public_digest.as_deref() != desired_digest {
            if let Some(digest) = old.public_digest.as_deref() {
                self.delete(&format!("public:{digest}")).await?;
            }
        }
        if let (Some(digest), Some(policy)) = (desired_digest, desired_policy.as_ref()) {
            if old.public_digest.as_deref() != Some(digest)
                || old.public_policy.as_ref() != Some(policy)
            {
                self.put(
                    &format!("public:{digest}"),
                    &serde_json::to_string(policy)
                        .map_err(|_| "edge policy serialization failed")?,
                    "application/json",
                )
                .await?;
            }
        }
        for key in old_revocations.difference(&desired_revocations) {
            if key.starts_with("revoked:signing_key:")
                && repository
                    .is_irreversible_key_revocation(package_id, key)
                    .await
                    .map_err(database)?
            {
                continue;
            }
            self.delete(key).await?;
        }
        let keys = desired_revocations.into_iter().collect::<Vec<_>>();
        repository
            .save_edge_state(package_id, desired_digest, desired_policy.as_ref(), &keys)
            .await
            .map_err(database)
    }

    async fn put(&self, key: &str, value: &str, content_type: &str) -> Result<(), String> {
        let response = self
            .client
            .put(self.key_url(key)?)
            .bearer_auth(&self.token)
            .header("content-type", content_type)
            .body(value.to_owned())
            .send()
            .await
            .map_err(|_| "edge policy write request failed".to_owned())?;
        verify(response).await
    }

    async fn delete(&self, key: &str) -> Result<(), String> {
        let response = self
            .client
            .delete(self.key_url(key)?)
            .bearer_auth(&self.token)
            .send()
            .await
            .map_err(|_| "edge policy delete request failed".to_owned())?;
        if response.status() == StatusCode::NOT_FOUND {
            return Ok(());
        }
        verify(response).await
    }

    fn key_url(&self, key: &str) -> Result<Url, String> {
        let mut url = self.base.clone();
        let mut path = url
            .path_segments_mut()
            .map_err(|_| "edge policy API URL cannot be a base".to_owned())?;
        path.pop_if_empty();
        path.extend([
            "accounts",
            &self.account_id,
            "storage",
            "kv",
            "namespaces",
            &self.namespace_id,
            "values",
            key,
        ]);
        drop(path);
        Ok(url)
    }
}

async fn verify(response: reqwest::Response) -> Result<(), String> {
    let status = response.status();
    if !status.is_success() {
        return Err(format!("edge policy API returned {status}"));
    }
    let body = response
        .json::<ApiResponse>()
        .await
        .map_err(|_| "edge policy API response was invalid".to_owned())?;
    body.success
        .then_some(())
        .ok_or_else(|| "edge policy API rejected the operation".to_owned())
}

fn public_policy(document: &SearchPackageDocument) -> Option<Value> {
    if document.package.kind != PackageKind::Art {
        return None;
    }
    Some(json!({
        "publisher_id":document.package.publisher.id,
        "package_id":document.package.id,
        "release_id":document.release_id,
        "artifact_id":document.artifact_id,
        "signing_key_id":document.signing_key_id,
        "digest":document.digest,
        "object_key":format!("sha256/{}/{}",&document.digest[..2],document.digest),
        "file_name":document.file_name,
    }))
}

fn database(error: sqlx::Error) -> String {
    format!("edge policy database operation failed: {error}")
}
