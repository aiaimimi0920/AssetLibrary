use http::{HeaderMap, HeaderName, HeaderValue};
use metrics::{
    Unit, counter, describe_counter, describe_gauge, describe_histogram, gauge, histogram,
};
use metrics_exporter_prometheus::{Matcher, PrometheusBuilder, PrometheusHandle};
use opentelemetry::{
    Context, global,
    propagation::{Extractor, Injector},
    trace::TracerProvider,
};
use opentelemetry_otlp::{Protocol, WithExportConfig};
use opentelemetry_sdk::{Resource, propagation::TraceContextPropagator, trace::SdkTracerProvider};
use std::{env, error::Error, net::SocketAddr, time::Duration};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{EnvFilter, layer::SubscriberExt, util::SubscriberInitExt};

pub type TelemetryError = Box<dyn Error + Send + Sync + 'static>;

pub enum MetricsEndpoint {
    Embedded,
    Http(SocketAddr),
}

pub struct Telemetry {
    metrics: Option<PrometheusHandle>,
    tracer_provider: Option<SdkTracerProvider>,
}

impl Telemetry {
    pub fn render_metrics(&self) -> Option<String> {
        self.metrics.as_ref().map(PrometheusHandle::render)
    }
}

impl Drop for Telemetry {
    fn drop(&mut self) {
        if let Some(provider) = self.tracer_provider.take() {
            let _ = provider.shutdown();
        }
    }
}

pub fn init(service: &'static str, endpoint: MetricsEndpoint) -> Result<Telemetry, TelemetryError> {
    let metrics = install_metrics(service, endpoint)?;
    global::set_text_map_propagator(TraceContextPropagator::new());
    let filter = EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info"));
    let formatting = tracing_subscriber::fmt::layer()
        .json()
        .with_current_span(true)
        .with_span_list(true);

    let tracer_provider = if otlp_is_configured() {
        let exporter = opentelemetry_otlp::SpanExporter::builder()
            .with_http()
            .with_protocol(Protocol::HttpBinary)
            .build()?;
        let provider = SdkTracerProvider::builder()
            .with_resource(Resource::builder().with_service_name(service).build())
            .with_batch_exporter(exporter)
            .build();
        let tracer = provider.tracer(service);
        tracing_subscriber::registry()
            .with(filter)
            .with(formatting)
            .with(tracing_opentelemetry::layer().with_tracer(tracer))
            .try_init()?;
        global::set_tracer_provider(provider.clone());
        Some(provider)
    } else {
        tracing_subscriber::registry()
            .with(filter)
            .with(formatting)
            .try_init()?;
        None
    };
    describe_metrics();
    Ok(Telemetry {
        metrics,
        tracer_provider,
    })
}

pub fn metrics_endpoint_from_env() -> Result<MetricsEndpoint, TelemetryError> {
    let value = env::var("ASSETLIBRARY_METRICS_BIND").unwrap_or_else(|_| "0.0.0.0:9090".to_owned());
    Ok(MetricsEndpoint::Http(value.parse()?))
}

fn install_metrics(
    service: &'static str,
    endpoint: MetricsEndpoint,
) -> Result<Option<PrometheusHandle>, TelemetryError> {
    let builder = PrometheusBuilder::new()
        .add_global_label("service", service)
        .with_recommended_naming(true)
        .set_buckets_for_metric(
            Matcher::Suffix("duration_seconds".to_owned()),
            &[
                0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0, 30.0, 120.0,
            ],
        )?;
    match endpoint {
        MetricsEndpoint::Embedded => Ok(Some(builder.install_recorder()?)),
        MetricsEndpoint::Http(address) => {
            builder.with_http_listener(address).install()?;
            Ok(None)
        }
    }
}

fn describe_metrics() {
    describe_counter!("assetlibrary_http_requests", "Completed HTTP requests");
    describe_histogram!(
        "assetlibrary_http_request_duration_seconds",
        Unit::Seconds,
        "HTTP request duration"
    );
    describe_gauge!(
        "assetlibrary_http_in_flight",
        "HTTP requests currently in flight"
    );
    describe_counter!(
        "assetlibrary_worker_operations",
        "Completed worker operations"
    );
    describe_histogram!(
        "assetlibrary_worker_operation_duration_seconds",
        Unit::Seconds,
        "Worker operation duration"
    );
    describe_counter!(
        "assetlibrary_dependency_requests",
        "Completed outbound dependency requests"
    );
    describe_histogram!(
        "assetlibrary_dependency_request_duration_seconds",
        Unit::Seconds,
        "Outbound dependency request duration"
    );
    describe_counter!(
        "assetlibrary_cache_operations",
        "Completed bounded cache operations"
    );
    describe_histogram!(
        "assetlibrary_cache_operation_duration_seconds",
        Unit::Seconds,
        "Cache operation duration"
    );
    describe_gauge!(
        "assetlibrary_db_pool_connections",
        "Database pool connections"
    );
    describe_counter!(
        "assetlibrary_processed_bytes",
        Unit::Bytes,
        "Bytes processed by a bounded operation"
    );
    describe_histogram!(
        "assetlibrary_event_lag_seconds",
        Unit::Seconds,
        "Delay from event occurrence to processing"
    );
    describe_gauge!(
        "assetlibrary_jetstream_consumer_pending",
        "Messages pending for a JetStream consumer"
    );
}

pub struct InFlight {
    service_area: &'static str,
}

impl InFlight {
    pub fn enter(service_area: &'static str) -> Self {
        gauge!("assetlibrary_http_in_flight", "area" => service_area).increment(1.0);
        Self { service_area }
    }
}

impl Drop for InFlight {
    fn drop(&mut self) {
        gauge!("assetlibrary_http_in_flight", "area" => self.service_area).decrement(1.0);
    }
}

pub fn record_http(method: &str, route: &str, status: u16, duration: Duration) {
    let status = status.to_string();
    counter!(
        "assetlibrary_http_requests",
        "method" => method.to_owned(),
        "route" => route.to_owned(),
        "status" => status
    )
    .increment(1);
    histogram!(
        "assetlibrary_http_request_duration_seconds",
        "method" => method.to_owned(),
        "route" => route.to_owned()
    )
    .record(duration.as_secs_f64());
}

pub fn record_worker(operation: &'static str, outcome: &'static str, duration: Duration) {
    counter!("assetlibrary_worker_operations", "operation" => operation, "outcome" => outcome)
        .increment(1);
    histogram!("assetlibrary_worker_operation_duration_seconds", "operation" => operation)
        .record(duration.as_secs_f64());
}

pub fn record_dependency(
    dependency: &'static str,
    operation: &'static str,
    outcome: &'static str,
    duration: Duration,
) {
    counter!(
        "assetlibrary_dependency_requests",
        "dependency" => dependency,
        "operation" => operation,
        "outcome" => outcome
    )
    .increment(1);
    histogram!(
        "assetlibrary_dependency_request_duration_seconds",
        "dependency" => dependency,
        "operation" => operation
    )
    .record(duration.as_secs_f64());
}

pub fn record_cache(cache: &'static str, outcome: &'static str, duration: Duration) {
    counter!(
        "assetlibrary_cache_operations",
        "cache" => cache,
        "outcome" => outcome
    )
    .increment(1);
    histogram!("assetlibrary_cache_operation_duration_seconds", "cache" => cache)
        .record(duration.as_secs_f64());
}

pub fn record_db_pool(pool: &'static str, open: u32, idle: usize, maximum: u32) {
    for (state, value) in [
        ("open", f64::from(open)),
        ("idle", idle as f64),
        ("maximum", f64::from(maximum)),
    ] {
        gauge!("assetlibrary_db_pool_connections", "pool" => pool, "state" => state).set(value);
    }
}

pub fn monitor_postgres_pool(
    pool: sqlx::PgPool,
    name: &'static str,
    maximum: u32,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(15));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        loop {
            interval.tick().await;
            record_db_pool(name, pool.size(), pool.num_idle(), maximum);
        }
    })
}

pub fn record_processed_bytes(operation: &'static str, bytes: u64) {
    counter!("assetlibrary_processed_bytes", "operation" => operation).increment(bytes);
}

pub fn record_event_lag(subject: &'static str, seconds: f64) {
    histogram!("assetlibrary_event_lag_seconds", "subject" => subject).record(seconds.max(0.0));
}

pub fn record_consumer_pending(subject: &'static str, pending: u64) {
    gauge!("assetlibrary_jetstream_consumer_pending", "subject" => subject).set(pending as f64);
}

pub fn set_parent_from_headers(span: &tracing::Span, headers: &HeaderMap) {
    let parent =
        global::get_text_map_propagator(|propagator| propagator.extract(&Headers(headers)));
    let _ = span.set_parent(parent);
}

pub fn inject_current_context(headers: &mut HeaderMap) {
    let context: Context = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&context, &mut HeadersMut(headers));
    });
}

pub fn current_trace_headers() -> Vec<(String, String)> {
    let mut headers = Vec::new();
    let context: Context = tracing::Span::current().context();
    global::get_text_map_propagator(|propagator| {
        propagator.inject_context(&context, &mut Pairs(&mut headers));
    });
    headers
}

pub fn set_parent_from_values(
    span: &tracing::Span,
    traceparent: Option<&str>,
    tracestate: Option<&str>,
) {
    let mut headers = HeaderMap::new();
    for (name, value) in [("traceparent", traceparent), ("tracestate", tracestate)] {
        if let Some(value) = value
            && let Ok(value) = HeaderValue::try_from(value)
        {
            headers.insert(HeaderName::from_static(name), value);
        }
    }
    set_parent_from_headers(span, &headers);
}

fn otlp_is_configured() -> bool {
    [
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "OTEL_EXPORTER_OTLP_ENDPOINT",
    ]
    .iter()
    .any(|name| env::var(name).is_ok_and(|value| !value.trim().is_empty()))
}

struct Headers<'a>(&'a HeaderMap);

impl Extractor for Headers<'_> {
    fn get(&self, key: &str) -> Option<&str> {
        self.0.get(key).and_then(|value| value.to_str().ok())
    }

    fn keys(&self) -> Vec<&str> {
        self.0.keys().map(HeaderName::as_str).collect()
    }
}

struct HeadersMut<'a>(&'a mut HeaderMap);

impl Injector for HeadersMut<'_> {
    fn set(&mut self, key: &str, value: String) {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(key), HeaderValue::try_from(value)) {
            self.0.insert(name, value);
        }
    }
}

struct Pairs<'a>(&'a mut Vec<(String, String)>);

impl Injector for Pairs<'_> {
    fn set(&mut self, key: &str, value: String) {
        self.0.push((key.to_owned(), value));
    }
}

#[cfg(test)]
mod tests {
    use super::{Headers, HeadersMut};
    use http::{HeaderMap, HeaderValue};
    use opentelemetry::propagation::{Extractor, Injector};

    #[test]
    fn header_carriers_ignore_invalid_values() {
        let mut headers = HeaderMap::new();
        HeadersMut(&mut headers).set("traceparent", "00-a-valid-looking-value".to_owned());
        assert_eq!(
            Headers(&headers).get("traceparent"),
            Some("00-a-valid-looking-value")
        );
        HeadersMut(&mut headers).set("not a header", "ignored".to_owned());
        assert_eq!(headers.len(), 1);
        headers.insert("x-binary", HeaderValue::from_bytes(&[0xff]).unwrap());
        assert_eq!(Headers(&headers).get("x-binary"), None);
    }
}
