use crate::config::OidcConfig;
use async_trait::async_trait;
use jsonwebtoken::{Algorithm, DecodingKey, Validation, decode, decode_header, jwk::JwkSet};
use serde::{Deserialize, Serialize};
use std::time::{Duration, Instant};
use tokio::sync::{Mutex, RwLock};

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct PrincipalRef {
    pub issuer: String,
    pub subject: String,
}

#[derive(Debug)]
pub enum IdentityError {
    MissingCredential,
    InvalidCredential,
    ExternalUnavailable,
}

#[async_trait]
pub trait IdentityProvider: Send + Sync {
    async fn authenticate(
        &self,
        authorization: Option<&str>,
    ) -> Result<PrincipalRef, IdentityError>;
}

pub struct DevelopmentIdentityAdapter;

#[async_trait]
impl IdentityProvider for DevelopmentIdentityAdapter {
    async fn authenticate(
        &self,
        authorization: Option<&str>,
    ) -> Result<PrincipalRef, IdentityError> {
        let credential = authorization.ok_or(IdentityError::MissingCredential)?;
        let subject = credential
            .strip_prefix("Bearer dev-")
            .filter(|value| !value.is_empty() && value.len() <= 120)
            .ok_or(IdentityError::InvalidCredential)?;
        Ok(PrincipalRef {
            issuer: "assetlibrary-development".to_owned(),
            subject: subject.to_owned(),
        })
    }
}

struct CachedJwks {
    set: JwkSet,
    expires_at: Instant,
}

pub struct ExternalIdentityAdapter {
    issuer: String,
    audience: String,
    jwks_url: reqwest::Url,
    client: reqwest::Client,
    cache: RwLock<Option<CachedJwks>>,
    refresh_lock: Mutex<()>,
}

impl ExternalIdentityAdapter {
    pub fn new(config: OidcConfig) -> Result<Self, String> {
        let jwks_url = reqwest::Url::parse(&config.jwks_url)
            .map_err(|error| format!("invalid OIDC JWKS URL: {error}"))?;
        if jwks_url.scheme() != "https" || !config.issuer.starts_with("https://") {
            return Err("production OIDC issuer and JWKS URL must use HTTPS".to_owned());
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(5))
            .redirect(reqwest::redirect::Policy::none())
            .user_agent("neuro-assetlibrary/0.1")
            .build()
            .map_err(|error| format!("failed to build OIDC client: {error}"))?;
        Ok(Self {
            issuer: config.issuer,
            audience: config.audience,
            jwks_url,
            client,
            cache: RwLock::new(None),
            refresh_lock: Mutex::new(()),
        })
    }

    async fn cached_key(&self, kid: &str) -> Option<DecodingKey> {
        let cache = self.cache.read().await;
        cache
            .as_ref()
            .filter(|cached| cached.expires_at > Instant::now())
            .and_then(|cached| cached.set.find(kid))
            .and_then(|jwk| DecodingKey::from_jwk(jwk).ok())
    }

    async fn decoding_key(&self, kid: &str) -> Result<DecodingKey, IdentityError> {
        let cache_started = Instant::now();
        if let Some(key) = self.cached_key(kid).await {
            assetlibrary_telemetry::record_cache("oidc_jwks", "hit", cache_started.elapsed());
            return Ok(key);
        }
        assetlibrary_telemetry::record_cache("oidc_jwks", "miss", cache_started.elapsed());
        let _guard = self.refresh_lock.lock().await;
        let cache_started = Instant::now();
        if let Some(key) = self.cached_key(kid).await {
            assetlibrary_telemetry::record_cache(
                "oidc_jwks",
                "hit_after_wait",
                cache_started.elapsed(),
            );
            return Ok(key);
        }
        let mut trace_headers = reqwest::header::HeaderMap::new();
        assetlibrary_telemetry::inject_current_context(&mut trace_headers);
        let started = Instant::now();
        let response = self
            .client
            .get(self.jwks_url.clone())
            .headers(trace_headers)
            .send()
            .await;
        let response = match response {
            Ok(response) if response.status().is_success() => response,
            Ok(_) => {
                assetlibrary_telemetry::record_dependency(
                    "oidc_jwks",
                    "refresh",
                    "http_error",
                    started.elapsed(),
                );
                return Err(IdentityError::ExternalUnavailable);
            }
            Err(_) => {
                assetlibrary_telemetry::record_dependency(
                    "oidc_jwks",
                    "refresh",
                    "transport_error",
                    started.elapsed(),
                );
                return Err(IdentityError::ExternalUnavailable);
            }
        };
        if response
            .content_length()
            .is_some_and(|length| length > 1_048_576)
        {
            assetlibrary_telemetry::record_dependency(
                "oidc_jwks",
                "refresh",
                "oversized_response",
                started.elapsed(),
            );
            return Err(IdentityError::ExternalUnavailable);
        }
        let body = match response.bytes().await {
            Ok(body) => body,
            Err(_) => {
                assetlibrary_telemetry::record_dependency(
                    "oidc_jwks",
                    "refresh",
                    "invalid_response",
                    started.elapsed(),
                );
                return Err(IdentityError::ExternalUnavailable);
            }
        };
        if body.len() > 1_048_576 {
            assetlibrary_telemetry::record_dependency(
                "oidc_jwks",
                "refresh",
                "oversized_response",
                started.elapsed(),
            );
            return Err(IdentityError::ExternalUnavailable);
        }
        let set: JwkSet = match serde_json::from_slice(&body) {
            Ok(set) => set,
            Err(_) => {
                assetlibrary_telemetry::record_dependency(
                    "oidc_jwks",
                    "refresh",
                    "invalid_response",
                    started.elapsed(),
                );
                return Err(IdentityError::ExternalUnavailable);
            }
        };
        if set.keys.is_empty() || set.keys.len() > 100 {
            assetlibrary_telemetry::record_dependency(
                "oidc_jwks",
                "refresh",
                "invalid_response",
                started.elapsed(),
            );
            return Err(IdentityError::ExternalUnavailable);
        }
        let key = match set
            .find(kid)
            .and_then(|jwk| DecodingKey::from_jwk(jwk).ok())
        {
            Some(key) => key,
            None => {
                assetlibrary_telemetry::record_dependency(
                    "oidc_jwks",
                    "refresh",
                    "unknown_key",
                    started.elapsed(),
                );
                return Err(IdentityError::InvalidCredential);
            }
        };
        *self.cache.write().await = Some(CachedJwks {
            set,
            expires_at: Instant::now() + Duration::from_secs(300),
        });
        assetlibrary_telemetry::record_dependency(
            "oidc_jwks",
            "refresh",
            "success",
            started.elapsed(),
        );
        Ok(key)
    }
}

#[derive(Deserialize)]
struct Claims {
    sub: String,
}

#[async_trait]
impl IdentityProvider for ExternalIdentityAdapter {
    async fn authenticate(
        &self,
        authorization: Option<&str>,
    ) -> Result<PrincipalRef, IdentityError> {
        let token = authorization
            .and_then(|value| value.strip_prefix("Bearer "))
            .filter(|value| !value.is_empty() && value.len() <= 16_384)
            .ok_or(IdentityError::MissingCredential)?;
        let header = decode_header(token).map_err(|_| IdentityError::InvalidCredential)?;
        if !matches!(header.alg, Algorithm::RS256 | Algorithm::ES256) {
            return Err(IdentityError::InvalidCredential);
        }
        let kid = header
            .kid
            .as_deref()
            .ok_or(IdentityError::InvalidCredential)?;
        let key = self.decoding_key(kid).await?;
        let mut validation = Validation::new(header.alg);
        validation.leeway = 30;
        validation.validate_nbf = true;
        validation.reject_tokens_expiring_in_less_than = 5;
        validation.set_required_spec_claims(&["exp", "iss", "aud", "sub"]);
        validation.set_issuer(&[&self.issuer]);
        validation.set_audience(&[&self.audience]);
        let claims = decode::<Claims>(token, &key, &validation)
            .map_err(|_| IdentityError::InvalidCredential)?
            .claims;
        if claims.sub.is_empty() || claims.sub.len() > 200 {
            return Err(IdentityError::InvalidCredential);
        }
        Ok(PrincipalRef {
            issuer: self.issuer.clone(),
            subject: claims.sub,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{
        DevelopmentIdentityAdapter, ExternalIdentityAdapter, IdentityError, IdentityProvider,
    };
    use crate::config::OidcConfig;

    #[tokio::test]
    async fn development_identity_requires_explicit_dev_bearer() {
        let provider = DevelopmentIdentityAdapter;
        assert!(matches!(
            provider.authenticate(None).await,
            Err(IdentityError::MissingCredential)
        ));
        assert!(matches!(
            provider.authenticate(Some("Bearer production-token")).await,
            Err(IdentityError::InvalidCredential)
        ));
        let principal = provider
            .authenticate(Some("Bearer dev-publisher-1"))
            .await
            .unwrap();
        assert_eq!(principal.subject, "publisher-1");
    }

    #[test]
    fn external_identity_rejects_insecure_configuration() {
        let result = ExternalIdentityAdapter::new(OidcConfig {
            issuer: "http://accounts.example".to_owned(),
            audience: "assetlibrary".to_owned(),
            jwks_url: "http://accounts.example/jwks".to_owned(),
        });
        assert!(result.is_err());
    }
}
