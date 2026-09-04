use assetlibrary_telemetry::{current_trace_headers, record_worker};
use async_nats::jetstream::{self, message::PublishMessage, stream};
use bytes::Bytes;
use serde_json::Value;
use sqlx::{PgPool, postgres::PgPoolOptions};
use std::{
    env,
    time::{Duration, Instant},
};
use tracing::Instrument;
use uuid::Uuid;

type EventRow = (Uuid, String, Value, i32);

enum DispatchOutcome {
    Idle,
    Published,
    Retrying,
}

impl DispatchOutcome {
    fn label(&self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Published => "published",
            Self::Retrying => "retrying",
        }
    }
}

fn retry_delay(attempts: i32) -> Duration {
    Duration::from_millis(250 * 2u64.pow(u32::try_from(attempts.clamp(0, 5)).unwrap_or(5)))
}

async fn dispatch_one(
    pool: &PgPool,
    jetstream: &jetstream::Context,
) -> Result<DispatchOutcome, sqlx::Error> {
    let mut transaction = pool.begin().await?;
    let event = sqlx::query_as::<_, EventRow>(
        "SELECT id, subject, payload, attempts FROM outbox_events \
         WHERE published_at IS NULL ORDER BY occurred_at, id FOR UPDATE SKIP LOCKED LIMIT 1",
    )
    .fetch_optional(&mut *transaction)
    .await?;
    let Some((id, subject, payload, attempts)) = event else {
        transaction.commit().await?;
        return Ok(DispatchOutcome::Idle);
    };
    let span = tracing::info_span!(
        "outbox.dispatch",
        otel.kind = "producer",
        messaging.system = "nats",
        messaging.destination.name = %subject,
        messaging.message.id = %id,
    );
    async move {
        let encoded =
            serde_json::to_vec(&payload).map_err(|error| sqlx::Error::Protocol(error.to_string()))?;
        let mut message = PublishMessage::build()
            .payload(Bytes::from(encoded))
            .message_id(id.to_string());
        for (name, value) in current_trace_headers() {
            message = message.header(name, value);
        }
        let published = match jetstream.send_publish(subject, message).await {
            Ok(ack) => ack.await.is_ok(),
            Err(_) => false,
        };
        if !published {
            sqlx::query(
                "UPDATE outbox_events SET attempts = attempts + 1, last_error = 'nats_publish_failed' WHERE id = $1",
            )
            .bind(id)
            .execute(&mut *transaction)
            .await?;
            transaction.commit().await?;
            tokio::time::sleep(retry_delay(attempts)).await;
            return Ok(DispatchOutcome::Retrying);
        }
        sqlx::query(
            "UPDATE outbox_events SET published_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1",
        )
        .bind(id)
        .execute(&mut *transaction)
        .await?;
        transaction.commit().await?;
        Ok(DispatchOutcome::Published)
    }
    .instrument(span)
    .await
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let _telemetry = assetlibrary_telemetry::init(
        "assetlibrary-outbox-worker",
        assetlibrary_telemetry::metrics_endpoint_from_env()?,
    )?;
    let database_url = env::var("DATABASE_URL")?;
    let nats_url = env::var("ASSETLIBRARY_NATS_URL")?;
    let pool = PgPoolOptions::new()
        .max_connections(5)
        .connect(&database_url)
        .await?;
    let _pool_metrics = assetlibrary_telemetry::monitor_postgres_pool(pool.clone(), "primary", 5);
    let client = async_nats::connect(nats_url).await?;
    let jetstream = jetstream::new(client);
    jetstream
        .get_or_create_stream(stream::Config {
            name: "ASSETLIBRARY_EVENTS".to_owned(),
            subjects: vec!["assetlibrary.>".to_owned()],
            max_messages: 1_000_000,
            duplicate_window: Duration::from_secs(120),
            ..Default::default()
        })
        .await?;
    loop {
        let started = Instant::now();
        let result = dispatch_one(&pool, &jetstream).await;
        let outcome = match &result {
            Ok(outcome) => outcome.label(),
            Err(_) => "error",
        };
        record_worker("outbox_dispatch", outcome, started.elapsed());
        if matches!(result?, DispatchOutcome::Idle) {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                _ = tokio::time::sleep(Duration::from_millis(250)) => {}
            }
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::retry_delay;
    use std::time::Duration;

    #[test]
    fn retry_backoff_is_bounded() {
        assert_eq!(retry_delay(0), Duration::from_millis(250));
        assert_eq!(retry_delay(50), Duration::from_secs(8));
    }
}
