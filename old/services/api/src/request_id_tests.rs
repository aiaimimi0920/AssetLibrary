use axum::{
    Json, Router,
    body::{Body, to_bytes},
    extract::Request,
    http::{HeaderMap, HeaderName, HeaderValue, StatusCode},
    middleware,
    response::IntoResponse,
    routing::any,
};
use serde_json::{Value, json};
use tower::ServiceExt;
use tower_http::request_id::{
    MakeRequestUuid, PropagateRequestIdLayer, RequestId, SetRequestIdLayer,
};

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn unhex(value: &str) -> Vec<u8> {
    assert_eq!(value.len() % 2, 0);
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(&value[index..index + 2], 16).unwrap())
        .collect()
}

fn header_values(headers: &HeaderMap) -> Vec<String> {
    headers
        .get_all("x-request-id")
        .iter()
        .map(|value| hex(value.as_bytes()))
        .collect()
}

fn normalize_generated(data: &mut Value) {
    let encoded = data["request_ids"][0].as_str().unwrap().to_owned();
    let bytes = unhex(&encoded);
    let text = std::str::from_utf8(&bytes).unwrap();
    let id = uuid::Uuid::parse_str(text).unwrap();
    assert_eq!(id.get_version_num(), 4);
    assert_eq!(id.get_variant(), uuid::Variant::RFC4122);
    assert_eq!(id.to_string(), text);
    for field in ["request_ids", "response_ids"] {
        for value in data[field].as_array_mut().unwrap() {
            if value.as_str() == Some(&encoded) {
                *value = json!("<generated-v4>");
            }
        }
    }
    for field in ["request_extension", "response_extension"] {
        if data[field].as_str() == Some(&encoded) {
            data[field] = json!("<generated-v4>");
        }
    }
}

#[tokio::test]
async fn request_id_layers_preserve_frozen_header_and_response_behavior() {
    // Capture came from actual tower-http 0.6.11. This inert handler exercises
    // the production Set -> observe_http -> Propagate ordering without opening
    // storage, identity providers, object stores or network listeners.
    let golden: Value = serde_json::from_str(include_str!(
        "../../../fixtures/http/request-id-compatibility-v1.json"
    ))
    .unwrap();
    assert_eq!(golden["schema_version"], 1);
    let cases = golden["cases"].as_array().unwrap();
    assert_eq!(cases.len(), 11);
    for case in cases {
        let response_ids = case["handler_response"].as_array().unwrap().clone();
        let status = case["expected"]["status"].as_u64().unwrap() as u16;
        let header = HeaderName::from_static("x-request-id");
        let app = Router::new()
            .route(
                "/",
                any(move |request: Request<Body>| {
                    let response_ids = response_ids.clone();
                    async move {
                        let mut response = Json(json!({
                            "request_ids": header_values(request.headers()),
                            "request_extension": request.extensions().get::<RequestId>()
                                .map(|value| hex(value.header_value().as_bytes())),
                        }))
                        .into_response();
                        *response.status_mut() = StatusCode::from_u16(status).unwrap();
                        for value in response_ids {
                            response.headers_mut().append(
                                "x-request-id",
                                HeaderValue::from_bytes(&unhex(value.as_str().unwrap())).unwrap(),
                            );
                        }
                        response
                    }
                }),
            )
            .layer(PropagateRequestIdLayer::new(header.clone()))
            .layer(middleware::from_fn(super::observability::observe_http))
            .layer(SetRequestIdLayer::new(header, MakeRequestUuid));
        let mut request = Request::builder().uri("/").body(Body::empty()).unwrap();
        let incoming = case["incoming"].as_array().unwrap();
        for value in incoming {
            request.headers_mut().append(
                "x-request-id",
                HeaderValue::from_bytes(&unhex(value.as_str().unwrap())).unwrap(),
            );
        }
        let response = app.oneshot(request).await.unwrap();
        let response_ids = header_values(response.headers());
        let extension = response
            .extensions()
            .get::<RequestId>()
            .map(|value| hex(value.header_value().as_bytes()));
        let status = response.status().as_u16();
        let mut actual: Value =
            serde_json::from_slice(&to_bytes(response.into_body(), 4096).await.unwrap()).unwrap();
        actual["response_ids"] = json!(response_ids);
        actual["response_extension"] = json!(extension);
        actual["status"] = json!(status);
        if incoming.is_empty() {
            normalize_generated(&mut actual);
        }
        assert_eq!(actual, case["expected"], "{}", case["label"]);
    }
}
