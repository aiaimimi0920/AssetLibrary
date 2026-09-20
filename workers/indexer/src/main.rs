mod cache;
mod config;
mod edge_policy;
mod opensearch;
mod repository;

#[cfg(test)]
mod opensearch_tests;

use assetlibrary_contracts::CatalogInvalidated;
use assetlibrary_telemetry::{
    record_consumer_pending, record_event_lag, record_worker, set_parent_from_values,
};
use async_nats::jetstream::{self, consumer, message::AckKind, stream};
use cache::Cache;
use edge_policy::EdgePolicy;
use futures_util::StreamExt;
use opensearch::OpenSearch;
use repository::Repository;
use sqlx::postgres::PgPoolOptions;
use std::time::{Duration, Instant};
use tracing::Instrument;
use uuid::Uuid;

const SUBJECT: &str = "assetlibrary.catalog.invalidated.v1";
type DynError = Box<dyn std::error::Error + Send + Sync>;

struct Projector {
    repository: Repository,
    search: OpenSearch,
    cache: Cache,
    edge: Option<EdgePolicy>,
}

impl Projector {
    async fn project(&self, event_id: Uuid, package_id: Uuid) -> Result<(), String> {
        let guard = self.repository.projection_guard().await.map_err(database)?;
        if self
            .repository
            .was_processed(event_id)
            .await
            .map_err(database)?
        {
            guard.commit().await.map_err(database)?;
            return Ok(());
        }
        let document = self
            .repository
            .document(package_id)
            .await
            .map_err(database)?;
        match document.as_ref() {
            Some(document) => self.search.upsert(&self.search.alias, document).await?,
            None => self.search.delete(&self.search.alias, package_id).await?,
        }
        if let Some(edge) = self.edge.as_ref() {
            edge.reconcile(&self.repository, package_id, document.as_ref())
                .await?;
        }
        self.cache
            .invalidate(package_id)
            .await
            .map_err(|_| "Valkey invalidation failed".to_owned())?;
        self.repository
            .mark_processed(event_id, package_id)
            .await
            .map_err(database)?;
        guard.commit().await.map_err(database)
    }

    async fn rebuild(&self) -> Result<String, String> {
        let guard = self.repository.projection_guard().await.map_err(database)?;
        let index = self.search.create_rebuild_index().await?;
        if let Err(error) = self.populate_rebuild(&index).await {
            let _ = self.search.delete_if_unaliased(&index).await;
            return Err(error);
        }
        if let Err(error) = self.search.swap_alias(&index).await {
            let _ = self.search.delete_if_unaliased(&index).await;
            return Err(error);
        }
        self.repository
            .set_active_index(&self.search.alias, &index)
            .await
            .map_err(database)?;
        self.cache
            .invalidate_all()
            .await
            .map_err(|_| "Valkey generation invalidation failed".to_owned())?;
        guard.commit().await.map_err(database)?;
        Ok(index)
    }

    async fn populate_rebuild(&self, index: &str) -> Result<(), String> {
        let mut after = None;
        loop {
            let ids = self
                .repository
                .package_ids(after, 200)
                .await
                .map_err(database)?;
            if ids.is_empty() {
                break;
            }
            for package_id in ids.iter().copied() {
                let document = self
                    .repository
                    .document(package_id)
                    .await
                    .map_err(database)?;
                if let Some(document) = document.as_ref() {
                    self.search.upsert_for_rebuild(&index, document).await?;
                }
            }
            after = ids.last().copied();
        }
        self.search.refresh(&index).await?;
        Ok(())
    }
}

async fn handle_message(
    message: async_nats::jetstream::Message,
    projector: &Projector,
) -> Result<(), DynError> {
    if let Ok(info) = message.info() {
        record_consumer_pending(SUBJECT, info.pending);
        let lag = (time::OffsetDateTime::now_utc() - info.published).as_seconds_f64();
        record_event_lag(SUBJECT, lag);
    }
    let traceparent = message
        .headers
        .as_ref()
        .and_then(|headers| headers.get("traceparent"))
        .map(|value| value.as_str().to_owned());
    let tracestate = message
        .headers
        .as_ref()
        .and_then(|headers| headers.get("tracestate"))
        .map(|value| value.as_str().to_owned());
    let span = tracing::info_span!(
        "indexer.consume",
        otel.kind = "consumer",
        messaging.system = "nats",
        messaging.destination.name = SUBJECT,
    );
    set_parent_from_values(&span, traceparent.as_deref(), tracestate.as_deref());
    handle_message_inner(message, projector)
        .instrument(span)
        .await
}

async fn handle_message_inner(
    message: async_nats::jetstream::Message,
    projector: &Projector,
) -> Result<(), DynError> {
    let started = Instant::now();
    let event = serde_json::from_slice::<CatalogInvalidated>(&message.payload);
    let Ok(event) = event else {
        message.ack_with(AckKind::Term).await?;
        record_worker("catalog_projection", "invalid_payload", started.elapsed());
        return Ok(());
    };
    if !event.validate() {
        message.ack_with(AckKind::Term).await?;
        record_worker("catalog_projection", "invalid_event", started.elapsed());
        return Ok(());
    }
    match projector.project(event.event_id, event.package_id).await {
        Ok(()) => {
            message.ack().await?;
            record_worker("catalog_projection", "projected", started.elapsed());
        }
        Err(error) => {
            tracing::warn!(error_kind = %error, package_id = %event.package_id, "catalog projection failed");
            message
                .ack_with(AckKind::Nak(Some(Duration::from_secs(2))))
                .await?;
            record_worker("catalog_projection", "retrying", started.elapsed());
        }
    }
    Ok(())
}

#[tokio::main]
async fn main() -> Result<(), DynError> {
    let _telemetry = assetlibrary_telemetry::init(
        "assetlibrary-indexer-worker",
        assetlibrary_telemetry::metrics_endpoint_from_env()?,
    )?;
    let config = config::Config::from_env().map_err(std::io::Error::other)?;
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await?;
    let _pool_metrics = assetlibrary_telemetry::monitor_postgres_pool(pool.clone(), "primary", 5);
    let projector = Projector {
        repository: Repository::new(pool),
        search: OpenSearch::new(&config)?,
        cache: Cache::new(&config.valkey_url)?,
        edge: config
            .edge_policy
            .clone()
            .map(EdgePolicy::new)
            .transpose()?,
    };
    if std::env::args().nth(1).as_deref() == Some("rebuild") {
        let index = projector.rebuild().await.map_err(std::io::Error::other)?;
        tracing::info!(index, "catalog projection rebuild completed");
        return Ok(());
    }
    projector
        .search
        .ensure_live_index()
        .await
        .map_err(std::io::Error::other)?;
    let client = async_nats::connect(&config.nats_url).await?;
    let jetstream = jetstream::new(client);
    let stream = jetstream
        .get_or_create_stream(stream::Config {
            name: "ASSETLIBRARY_EVENTS".to_owned(),
            subjects: vec!["assetlibrary.>".to_owned()],
            max_messages: 1_000_000,
            duplicate_window: Duration::from_secs(120),
            ..Default::default()
        })
        .await?;
    let consumer = stream
        .get_or_create_consumer(
            &config.consumer_name,
            consumer::pull::Config {
                durable_name: Some(config.consumer_name.clone()),
                filter_subject: SUBJECT.to_owned(),
                ack_policy: consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(60),
                max_deliver: 20,
                max_ack_pending: 1,
                ..Default::default()
            },
        )
        .await?;
    let mut messages = consumer.messages().await?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            next = messages.next() => match next {
                Some(Ok(message)) => {
                    if let Err(error) = handle_message(message, &projector).await {
                        tracing::warn!(error_kind = %error, "indexer acknowledgement failed");
                    }
                }
                Some(Err(_)) => tokio::time::sleep(Duration::from_secs(1)).await,
                None => break,
            }
        }
    }
    Ok(())
}

fn database(error: sqlx::Error) -> String {
    format!("indexer database operation failed: {error}")
}
