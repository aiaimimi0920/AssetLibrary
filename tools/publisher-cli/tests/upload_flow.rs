use assert_cmd::Command;
use axum::{
    Json, Router,
    body::Bytes,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::Path,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
    time::{SystemTime, UNIX_EPOCH},
};
use tempfile::TempDir;
use tokio::net::TcpListener;
use uuid::Uuid;

const TOKEN: &str = "mock-account-secret-never-print";
const OBJECT_KEY: &str = "quarantine/private/secret-object-key";

#[derive(Clone)]
struct MockState {
    base: String,
    release_id: Uuid,
    session_id: Uuid,
    artifact_id: Uuid,
    size: u64,
    digest: String,
    allow_put: Arc<AtomicBool>,
    transient_failures: Arc<AtomicUsize>,
    create_calls: Arc<AtomicUsize>,
    put_calls: Arc<AtomicUsize>,
    bearer_leaked: Arc<AtomicBool>,
    uploaded: Arc<Mutex<Vec<u8>>>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn upload_recovers_without_recreating_session_or_leaking_bearer() {
    let temp = TempDir::new().unwrap();
    let archive = temp.path().join("payload.zip");
    let archive_bytes = b"bounded-upload-fixture";
    fs::write(&archive, archive_bytes).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let state = MockState {
        base: base.clone(),
        release_id: Uuid::new_v4(),
        session_id: Uuid::new_v4(),
        artifact_id: Uuid::new_v4(),
        size: archive_bytes.len() as u64,
        digest: format!("{:x}", Sha256::digest(archive_bytes)),
        allow_put: Arc::new(AtomicBool::new(false)),
        transient_failures: Arc::new(AtomicUsize::new(1)),
        create_calls: Arc::new(AtomicUsize::new(0)),
        put_calls: Arc::new(AtomicUsize::new(0)),
        bearer_leaked: Arc::new(AtomicBool::new(false)),
        uploaded: Arc::new(Mutex::new(Vec::new())),
    };
    let app = Router::new()
        .route(
            "/v1/me/releases/{release_id}/upload-sessions",
            post(create_upload),
        )
        .route("/v1/me/upload-sessions/{session_id}", get(upload_status))
        .route(
            "/v1/me/upload-sessions/{session_id}/parts/{part_number}",
            post(presign),
        )
        .route(
            "/v1/me/upload-sessions/{session_id}/complete",
            post(complete),
        )
        .route("/object", put(put_object))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let first = upload_command(&state, &archive).assert().failure().code(1);
    let first_output = first.get_output();
    assert!(!String::from_utf8_lossy(&first_output.stderr).contains(TOKEN));
    assert!(!String::from_utf8_lossy(&first_output.stderr).contains(OBJECT_KEY));
    let descriptor = archive.with_extension("zip.upload.json");
    assert!(descriptor.exists());
    assert_eq!(state.create_calls.load(Ordering::SeqCst), 1);

    state.allow_put.store(true, Ordering::SeqCst);
    let second = upload_command(&state, &archive)
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    let output: Value = serde_json::from_slice(&second).unwrap();
    assert_eq!(output["status"], "uploaded");
    assert_eq!(output["artifact_id"], state.artifact_id.to_string());
    assert!(!String::from_utf8_lossy(&second).contains(OBJECT_KEY));
    assert!(!descriptor.exists());
    assert_eq!(state.create_calls.load(Ordering::SeqCst), 1);
    assert_eq!(state.put_calls.load(Ordering::SeqCst), 3);
    assert!(!state.bearer_leaked.load(Ordering::SeqCst));
    assert_eq!(*state.uploaded.lock().unwrap(), archive_bytes);

    server.abort();
}

fn upload_command(state: &MockState, archive: &Path) -> Command {
    let mut command = Command::cargo_bin("assetlibrary-publisher").unwrap();
    command
        .env("ASSETLIBRARY_TOKEN", TOKEN)
        .arg("--json")
        .arg("upload")
        .arg("--api-url")
        .arg(&state.base)
        .arg("--allow-http")
        .arg("--release-id")
        .arg(state.release_id.to_string())
        .arg("--archive")
        .arg(archive)
        .arg("--part-size-mib")
        .arg("5")
        .arg("--upload-origins")
        .arg(&state.base);
    command
}

async fn create_upload(
    State(state): State<MockState>,
    AxumPath(release_id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if release_id != state.release_id
        || !authorized(&headers)
        || headers.get("idempotency-key").is_none()
        || headers.get("x-request-id").is_none()
        || request["size_bytes"] != state.size
        || request["expected_digest"]["value"] != format!("sha256:{}", state.digest)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    state.create_calls.fetch_add(1, Ordering::SeqCst);
    Json(session(&state, "pending_upload")).into_response()
}

async fn upload_status(
    State(state): State<MockState>,
    AxumPath(session_id): AxumPath<Uuid>,
    headers: HeaderMap,
) -> Response {
    if session_id != state.session_id || !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({
        "id": state.session_id,
        "release_id": state.release_id,
        "artifact_id": state.artifact_id,
        "part_size_bytes": 5 * 1024 * 1024,
        "max_parts": 1,
        "size_bytes": state.size,
        "expires_at_epoch_seconds": expires_at(),
        "status": "pending_upload",
        "expected_digest": {"algorithm":"sha256","value":format!("sha256:{}", state.digest)},
        "uploaded_parts": []
    }))
    .into_response()
}

async fn presign(
    State(state): State<MockState>,
    AxumPath((session_id, part_number)): AxumPath<(Uuid, u16)>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if session_id != state.session_id
        || part_number != 1
        || !authorized(&headers)
        || request["size_bytes"] != state.size
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    Json(json!({
        "part_number": 1,
        "method": "PUT",
        "url": format!("{}/object?part=1", state.base),
        "headers": {},
        "expires_in_seconds": 300
    }))
    .into_response()
}

async fn put_object(State(state): State<MockState>, headers: HeaderMap, body: Bytes) -> Response {
    state.put_calls.fetch_add(1, Ordering::SeqCst);
    if headers.contains_key(header::AUTHORIZATION) {
        state.bearer_leaked.store(true, Ordering::SeqCst);
        return StatusCode::IM_A_TEAPOT.into_response();
    }
    if !state.allow_put.load(Ordering::SeqCst) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if state
        .transient_failures
        .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |value| {
            value.checked_sub(1)
        })
        .is_ok()
    {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    *state.uploaded.lock().unwrap() = body.to_vec();
    let mut response = StatusCode::OK.into_response();
    response
        .headers_mut()
        .insert(header::ETAG, HeaderValue::from_static("\"etag-1\""));
    response
}

async fn complete(
    State(state): State<MockState>,
    AxumPath(session_id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if session_id != state.session_id
        || !authorized(&headers)
        || request["parts"]
            .as_array()
            .is_none_or(|parts| parts.len() != 1)
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    Json(session(&state, "uploaded")).into_response()
}

fn session(state: &MockState, status: &str) -> Value {
    json!({
        "id": state.session_id,
        "release_id": state.release_id,
        "artifact_id": state.artifact_id,
        "object_key": OBJECT_KEY,
        "part_size_bytes": 5 * 1024 * 1024,
        "max_parts": 1,
        "expires_at_epoch_seconds": expires_at(),
        "status": status,
        "expected_digest": {"algorithm":"sha256","value":format!("sha256:{}", state.digest)}
    })
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer {TOKEN}"))
}

fn expires_at() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs()
        + 600
}
