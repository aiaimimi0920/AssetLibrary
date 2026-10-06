mod config;
mod event;
mod inspection_executor;
mod inspection_process;
mod local_inspection;
mod malware;
mod pipeline;
mod repository;

use assetlibrary_object_store::S3ObjectStore;
use assetlibrary_telemetry::{
    record_consumer_pending, record_event_lag, record_processed_bytes, record_worker,
    set_parent_from_values,
};
use async_nats::jetstream::{self, consumer, message::AckKind, stream};
use event::VerificationRequested;
use futures_util::StreamExt;
use pipeline::{Pipeline, PipelineError};
use repository::{
    Claim, MAX_EVIDENCE_DELIVERIES, MAX_PIPELINE_ATTEMPTS, Repository, VerifiedRecord,
};
use sqlx::postgres::PgPoolOptions;
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::Instrument;

const SUBJECT: &str = "assetlibrary.artifact.verification_requested.v1";
type DynError = Box<dyn std::error::Error + Send + Sync>;

#[derive(Debug, thiserror::Error)]
enum WorkError {
    #[error("pipeline failed")]
    Pipeline(#[from] PipelineError),
    #[error("database failed")]
    Database(#[from] sqlx::Error),
}

async fn run_pipeline(
    pipeline: &Pipeline,
    repository: &Repository,
    context: &repository::ArtifactContext,
    event: &VerificationRequested,
) -> Result<VerifiedRecord, WorkError> {
    let inspection = pipeline.inspect(context, event).await?;
    let key = repository
        .trusted_key(context.publisher_id, &inspection_key_id(&inspection))
        .await?
        .ok_or(PipelineError::Permanent("publisher_key_untrusted"))?;
    pipeline
        .verify_and_promote(inspection, &key, &context.media_type)
        .await
        .map_err(WorkError::from)
}

fn inspection_key_id(inspection: &pipeline::Inspection) -> String {
    inspection.key_id().to_owned()
}

async fn handle_message(
    message: async_nats::jetstream::Message,
    repository: &Repository,
    pipeline: &Pipeline,
    timeout: Duration,
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
        "scanner.consume",
        otel.kind = "consumer",
        messaging.system = "nats",
        messaging.destination.name = SUBJECT,
    );
    set_parent_from_values(&span, traceparent.as_deref(), tracestate.as_deref());
    handle_message_inner(message, repository, pipeline, timeout)
        .instrument(span)
        .await
}

async fn handle_message_inner(
    message: async_nats::jetstream::Message,
    repository: &Repository,
    pipeline: &Pipeline,
    timeout: Duration,
) -> Result<(), DynError> {
    let delivery = message.info().map(|info| info.delivered).unwrap_or(1);
    let event = serde_json::from_slice::<VerificationRequested>(&message.payload);
    let Ok(event) = event else {
        message.ack_with(AckKind::Term).await?;
        return Ok(());
    };
    if !event.validate() {
        message.ack_with(AckKind::Term).await?;
        return Ok(());
    }
    let context = match repository.claim(&event, delivery).await {
        Ok(Claim::Ready(context)) => context,
        Ok(Claim::Terminal) => {
            message.ack().await?;
            return Ok(());
        }
        Ok(Claim::Discard) => {
            message.ack_with(AckKind::Term).await?;
            return Ok(());
        }
        Err(error) => {
            message
                .ack_with(AckKind::Nak(Some(Duration::from_secs(2))))
                .await?;
            return Err(error.into());
        }
    };

    let started = Instant::now();
    let result = tokio::time::timeout(
        timeout,
        Box::pin(run_pipeline(pipeline, repository, &context, &event)),
    )
    .await;
    match result {
        Ok(Ok(record)) => {
            if let Err(error) = repository
                .mark_verified(&context, event.event_id, delivery, record)
                .await
            {
                message
                    .ack_with(AckKind::Nak(Some(Duration::from_secs(2))))
                    .await?;
                return Err(error.into());
            }
            message.ack().await?;
            record_processed_bytes("artifact_scan", context.size_bytes);
            record_worker("artifact_scan", "verified", started.elapsed());
        }
        Ok(Err(WorkError::Pipeline(PipelineError::Permanent(code)))) => {
            if let Err(error) = repository
                .mark_quarantined(&context, event.event_id, delivery, code)
                .await
            {
                message
                    .ack_with(AckKind::Nak(Some(Duration::from_secs(2))))
                    .await?;
                return Err(error.into());
            }
            message.ack().await?;
            record_processed_bytes("artifact_scan", context.size_bytes);
            record_worker("artifact_scan", "quarantined", started.elapsed());
        }
        Ok(Err(WorkError::Pipeline(PipelineError::Retry(code)))) => {
            handle_retry(&message, repository, &context, &event, delivery, code).await?;
            record_worker("artifact_scan", "retrying", started.elapsed());
        }
        Err(_) => {
            handle_retry(
                &message,
                repository,
                &context,
                &event,
                delivery,
                "scanner_timeout",
            )
            .await?;
            record_worker("artifact_scan", "timeout", started.elapsed());
        }
        Ok(Err(WorkError::Database(error))) => {
            message
                .ack_with(AckKind::Nak(Some(Duration::from_secs(2))))
                .await?;
            record_worker("artifact_scan", "database_error", started.elapsed());
            return Err(error.into());
        }
    }
    Ok(())
}

async fn handle_retry(
    message: &async_nats::jetstream::Message,
    repository: &Repository,
    context: &repository::ArtifactContext,
    event: &VerificationRequested,
    delivery: i64,
    code: &str,
) -> Result<(), DynError> {
    if delivery >= MAX_PIPELINE_ATTEMPTS {
        if let Err(error) = repository
            .mark_retry_exhausted(context, event, delivery, code)
            .await
        {
            message
                .ack_with(AckKind::Nak(Some(Duration::from_secs(2))))
                .await?;
            return Err(error.into());
        }
        message.ack().await?;
    } else {
        let recorded = repository
            .record_retry(context, event.event_id, delivery, code)
            .await;
        message
            .ack_with(AckKind::Nak(Some(retry_delay(delivery))))
            .await?;
        recorded?;
    }
    Ok(())
}

fn retry_delay(delivery: i64) -> Duration {
    Duration::from_secs(2u64.pow(u32::try_from(delivery.clamp(1, 5)).unwrap_or(5)))
}

fn main() -> Result<(), DynError> {
    let arguments: Vec<_> = std::env::args_os().skip(1).collect();
    if arguments.len() == 1 && arguments[0] == "--inspect-local" {
        return inspection_process::run_child_entry().map_err(Into::into);
    }
    if !arguments.is_empty() {
        return Err(std::io::Error::other("unsupported scanner arguments").into());
    }
    run_worker()
}

#[tokio::main]
async fn run_worker() -> Result<(), DynError> {
    let _telemetry = assetlibrary_telemetry::init(
        "assetlibrary-scanner-worker",
        assetlibrary_telemetry::metrics_endpoint_from_env()?,
    )?;
    let config = config::Config::from_env().map_err(std::io::Error::other)?;
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.database_url)
        .await?;
    let _pool_metrics = assetlibrary_telemetry::monitor_postgres_pool(pool.clone(), "primary", 5);
    let repository = Repository::new(pool);
    let object_store = Arc::new(S3ObjectStore::new(config.object_store).await?);
    let pipeline = Pipeline::new(
        object_store,
        config.clamav_address,
        config.temporary_root,
        config.scan_timeout,
    );
    let client = async_nats::connect(config.nats_url).await?;
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
                deliver_policy: if config.deliver_new_only {
                    consumer::DeliverPolicy::New
                } else {
                    consumer::DeliverPolicy::All
                },
                ack_policy: consumer::AckPolicy::Explicit,
                ack_wait: Duration::from_secs(180),
                // Five pipeline attempts exhaust to the application DLQ; the
                // remaining deliveries protect terminal evidence persistence.
                max_deliver: MAX_EVIDENCE_DELIVERIES,
                max_ack_pending: 1,
                ..Default::default()
            },
        )
        .await?;
    let mut messages = consumer.messages().await?;
    loop {
        tokio::select! {
            _ = tokio::signal::ctrl_c() => break,
            next = async {
                // Cancellation must kill/reap the previous inspector before
                // another artifact is claimed or its temporary files are used.
                pipeline.wait_for_idle().await;
                messages.next().await
            } => match next {
                Some(Ok(message)) => {
                    let handled = Box::pin(handle_message(
                        message,
                        &repository,
                        &pipeline,
                        config.scan_timeout,
                    ))
                    .await;
                    if let Err(error) = handled {
                        tracing::warn!(error_kind = %error, "scanner message acknowledgement failed");
                    }
                }
                Some(Err(_)) => tokio::time::sleep(Duration::from_secs(1)).await,
                None => break,
            }
        }
    }
    pipeline.wait_for_idle().await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::retry_delay;
    use std::time::Duration;

    #[test]
    fn retry_delay_is_bounded() {
        assert_eq!(retry_delay(1), Duration::from_secs(2));
        assert_eq!(retry_delay(100), Duration::from_secs(32));
    }
}
