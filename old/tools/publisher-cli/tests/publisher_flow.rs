use assert_cmd::Command;
use axum::{
    Json, Router,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use serde_json::{Value, json};
use std::sync::{
    Arc,
    atomic::{AtomicUsize, Ordering},
};
use tokio::net::TcpListener;
use uuid::Uuid;

const TOKEN: &str = "publisher-flow-account-token";
const NOW: &str = "2026-01-01T00:00:00Z";

#[derive(Clone)]
struct MockState {
    base: String,
    publisher_id: Uuid,
    package_id: Uuid,
    release_id: Uuid,
    artifact_id: Uuid,
    submission_id: Uuid,
    mutations: Arc<AtomicUsize>,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn publisher_commands_follow_the_versioned_api_contract() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let state = MockState {
        base: format!("http://{}", listener.local_addr().unwrap()),
        publisher_id: Uuid::new_v4(),
        package_id: Uuid::new_v4(),
        release_id: Uuid::new_v4(),
        artifact_id: Uuid::new_v4(),
        submission_id: Uuid::new_v4(),
        mutations: Arc::new(AtomicUsize::new(0)),
    };
    let app = Router::new()
        .route(
            "/v1/me/publishers/{publisher_id}/packages",
            post(create_package),
        )
        .route(
            "/v1/me/packages/{package_id}/releases",
            post(create_release),
        )
        .route("/v1/me/releases/{release_id}/submissions", post(submit))
        .route("/v1/me/releases/{release_id}/workspace", get(workspace))
        .with_state(state.clone());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });

    let package = remote_command(&state, "package-create")
        .arg("--publisher-id")
        .arg(state.publisher_id.to_string())
        .args([
            "--kind",
            "art",
            "--slug",
            "sample-art",
            "--name",
            "Sample Art",
        ])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        parse(&package)["package"]["id"],
        state.package_id.to_string()
    );

    let release = remote_command(&state, "release-create")
        .arg("--package-id")
        .arg(state.package_id.to_string())
        .args(["--version", "1.2.3", "--loom", "^1.0"])
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        parse(&release)["release"]["id"],
        state.release_id.to_string()
    );

    let submission = remote_command(&state, "submit")
        .arg("--release-id")
        .arg(state.release_id.to_string())
        .arg("--artifact-id")
        .arg(state.artifact_id.to_string())
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        parse(&submission)["submission"]["id"],
        state.submission_id.to_string()
    );

    let status = remote_command(&state, "status")
        .arg("--release-id")
        .arg(state.release_id.to_string())
        .assert()
        .success()
        .get_output()
        .stdout
        .clone();
    assert_eq!(
        parse(&status)["workspace"]["release_id"],
        state.release_id.to_string()
    );
    assert_eq!(state.mutations.load(Ordering::SeqCst), 3);
    for output in [&package, &release, &submission, &status] {
        assert!(!String::from_utf8_lossy(output).contains(TOKEN));
    }

    server.abort();
}

fn remote_command(state: &MockState, subcommand: &str) -> Command {
    let mut command = Command::cargo_bin("assetlibrary-publisher").unwrap();
    command
        .env("ASSETLIBRARY_TOKEN", TOKEN)
        .arg("--json")
        .arg(subcommand)
        .arg("--api-url")
        .arg(&state.base)
        .arg("--allow-http");
    command
}

async fn create_package(
    State(state): State<MockState>,
    AxumPath(publisher_id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if publisher_id != state.publisher_id
        || !mutation_headers(&headers)
        || request["slug"] != "sample-art"
        || request["kind"] != "art"
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    state.mutations.fetch_add(1, Ordering::SeqCst);
    Json(json!({
        "id":state.package_id,"publisher_id":state.publisher_id,"slug":"sample-art",
        "kind":"art","status":"draft","visibility":"private","name":"Sample Art",
        "summary":"","description":"","tags":[],"created_at":NOW,"updated_at":NOW
    }))
    .into_response()
}

async fn create_release(
    State(state): State<MockState>,
    AxumPath(package_id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if package_id != state.package_id
        || !mutation_headers(&headers)
        || request["version"] != "1.2.3"
        || request["compatibility"]["products"][0]["name"] != "loom"
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    state.mutations.fetch_add(1, Ordering::SeqCst);
    Json(json!({
        "id":state.release_id,"package_id":state.package_id,"version":"1.2.3",
        "status":"draft","compatibility":request["compatibility"],"permissions":[],
        "created_by":{"issuer":"account.test","subject":"publisher-user"},
        "published_at":null,"yanked_at":null,"created_at":NOW,"updated_at":NOW
    }))
    .into_response()
}

async fn submit(
    State(state): State<MockState>,
    AxumPath(release_id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(request): Json<Value>,
) -> Response {
    if release_id != state.release_id
        || !mutation_headers(&headers)
        || request["artifact_id"] != state.artifact_id.to_string()
    {
        return StatusCode::BAD_REQUEST.into_response();
    }
    state.mutations.fetch_add(1, Ordering::SeqCst);
    Json(json!({
        "id":state.submission_id,"release_id":state.release_id,"artifact_id":state.artifact_id,
        "revision":1,"status":"in_review","required_approvals":1,"approval_count":0,
        "scanner_version":"scanner-v1","rule_version":"rules-v1"
    }))
    .into_response()
}

async fn workspace(
    State(state): State<MockState>,
    AxumPath(release_id): AxumPath<Uuid>,
    headers: HeaderMap,
) -> Response {
    if release_id != state.release_id || !authorized(&headers) {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    Json(json!({
        "schema_version":"1.0","release_id":state.release_id,"artifacts":[],
        "artifacts_truncated":false,"submission":null,"feedback":[],
        "feedback_truncated":false,"can_upload":true
    }))
    .into_response()
}

fn mutation_headers(headers: &HeaderMap) -> bool {
    authorized(headers)
        && headers.get("idempotency-key").is_some()
        && headers.get("x-request-id").is_some()
}

fn authorized(headers: &HeaderMap) -> bool {
    headers
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        == Some(&format!("Bearer {TOKEN}"))
}

fn parse(bytes: &[u8]) -> Value {
    serde_json::from_slice(bytes).unwrap()
}
