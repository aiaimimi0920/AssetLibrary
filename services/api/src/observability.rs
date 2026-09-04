use assetlibrary_telemetry::{InFlight, record_http, set_parent_from_headers};
use axum::{
    body::Body,
    extract::{MatchedPath, Request},
    middleware::Next,
    response::Response,
};
use std::time::Instant;
use tracing::{Instrument, field, info_span};

pub async fn observe_http(request: Request<Body>, next: Next) -> Response {
    let method = request.method().as_str().to_owned();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str)
        .to_owned();
    let request_id = request
        .headers()
        .get("x-request-id")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("invalid")
        .to_owned();
    let span = info_span!(
        "http.request",
        otel.kind = "server",
        http.request.method = %method,
        http.route = %route,
        http.response.status_code = field::Empty,
        request.id = %request_id,
    );
    set_parent_from_headers(&span, request.headers());
    let started = Instant::now();
    let _in_flight = InFlight::enter("api");
    let response = next.run(request).instrument(span.clone()).await;
    let status = response.status().as_u16();
    span.record("http.response.status_code", status);
    record_http(&method, &route, status, started.elapsed());
    response
}
