use assetlibrary_telemetry::{
    current_trace_headers, inject_current_context, set_parent_from_headers, set_parent_from_values,
};
use http::HeaderMap;
use opentelemetry::{global, trace::TracerProvider};
use opentelemetry_sdk::{
    error::OTelSdkResult,
    propagation::TraceContextPropagator,
    trace::{SdkTracerProvider, SpanData, SpanExporter},
};
use std::sync::{Arc, Mutex};
use tracing_subscriber::layer::SubscriberExt;

const TRACE_ID: &str = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID: &str = "00f067aa0ba902b7";
const TRACEPARENT: &str = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";

#[derive(Clone, Debug, Default)]
struct Capture(Arc<Mutex<Vec<SpanData>>>);

impl SpanExporter for Capture {
    async fn export(&self, batch: Vec<SpanData>) -> OTelSdkResult {
        self.0.lock().unwrap().extend(batch);
        Ok(())
    }
}

// Keep one frozen W3C trace across the API/header and worker/value carriers.
// A local subscriber avoids changing the process-global subscriber in tests.
#[test]
fn http_and_worker_carriers_preserve_parentage_and_export() {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let capture = Capture::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(capture.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("contract")));
    tracing::subscriber::with_default(subscriber, || {
        let mut incoming = HeaderMap::new();
        incoming.insert("traceparent", TRACEPARENT.parse().unwrap());
        incoming.insert("tracestate", "vendor=opaque".parse().unwrap());
        incoming.insert("authorization", "Bearer never-propagate".parse().unwrap());
        let span = tracing::info_span!("api.contract");
        set_parent_from_headers(&span, &incoming);
        let outbound = span.in_scope(|| {
            let mut headers = HeaderMap::new();
            inject_current_context(&mut headers);
            assert_eq!(headers.len(), 2);
            assert_eq!(headers["tracestate"], "vendor=opaque");
            assert!(!headers.contains_key("authorization"));
            let pairs = current_trace_headers();
            assert_eq!(pairs.len(), 2);
            for (key, value) in pairs {
                assert_eq!(headers[key.as_str()].to_str().unwrap(), value);
            }
            headers
        });
        let worker = tracing::info_span!("worker.contract");
        set_parent_from_values(
            &worker,
            Some(outbound["traceparent"].to_str().unwrap()),
            Some(outbound["tracestate"].to_str().unwrap()),
        );
        worker.in_scope(|| {
            let pairs = current_trace_headers();
            assert!(pairs.iter().any(|(key, value)| {
                key == "traceparent" && value.starts_with(&format!("00-{TRACE_ID}-"))
            }));
        });
    });
    provider.force_flush().unwrap();
    provider.shutdown().unwrap();
    let spans = capture.0.lock().unwrap();
    assert_eq!(spans.len(), 2);
    let api = spans
        .iter()
        .find(|span| span.name == "api.contract")
        .unwrap();
    let worker = spans
        .iter()
        .find(|span| span.name == "worker.contract")
        .unwrap();
    assert_eq!(api.span_context.trace_id().to_string(), TRACE_ID);
    assert_eq!(api.parent_span_id.to_string(), PARENT_ID);
    assert!(api.parent_span_is_remote);
    assert_eq!(worker.span_context.trace_id(), api.span_context.trace_id());
    assert_eq!(worker.parent_span_id, api.span_context.span_id());
    assert!(worker.parent_span_is_remote);
    assert_eq!(worker.span_context.trace_state().header(), "vendor=opaque");
}

#[test]
fn invalid_remote_context_does_not_become_an_exported_parent() {
    global::set_text_map_propagator(TraceContextPropagator::new());
    let capture = Capture::default();
    let provider = SdkTracerProvider::builder()
        .with_simple_exporter(capture.clone())
        .build();
    let subscriber = tracing_subscriber::registry()
        .with(tracing_opentelemetry::layer().with_tracer(provider.tracer("contract")));
    tracing::subscriber::with_default(subscriber, || {
        for invalid in [
            "bad",
            "00-00000000000000000000000000000000-0000000000000000-01",
            "bad\r\nheader",
        ] {
            let span = tracing::info_span!("invalid.contract");
            set_parent_from_values(&span, Some(invalid), Some("bad\r\nstate"));
            span.in_scope(|| {
                let mut headers = HeaderMap::new();
                inject_current_context(&mut headers);
                assert!(headers.contains_key("traceparent"));
                assert!(
                    headers
                        .get("tracestate")
                        .is_none_or(|value| value.is_empty())
                );
            });
        }
    });
    provider.shutdown().unwrap();
    let spans = capture.0.lock().unwrap();
    assert_eq!(spans.len(), 3);
    for span in spans.iter() {
        assert!(span.span_context.is_valid());
        assert_eq!(span.parent_span_id.to_string(), "0000000000000000");
        assert!(!span.parent_span_is_remote);
    }
}
