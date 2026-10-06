use assetlibrary_contracts::{
    CreateDownloadSessionRequest, CreateInstallChallengeRequest, DownloadArtifact, DownloadSession,
    HostApiSupport, InstallChallenge, InstallHostProfile, InstallPackage, InstallReceipt,
    InstalledFramework, PackageKind, SCHEMA_VERSION_V1, SigningKeyAlgorithm, TrustedPublisherKey,
    VerifyInstallReceiptRequest,
};
use assetlibrary_supply_chain::{canonical_zip_digest, hex_digest, sha256_digest};
use axum::{
    Json, Router,
    body::Body,
    extract::{Path as AxumPath, State},
    http::{HeaderMap, Response, StatusCode, header},
    response::IntoResponse,
    routing::{get, post},
};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use ed25519_dalek::{Signer, SigningKey};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    io::{Cursor, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use time::{Duration, OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;
use zip::{ZipWriter, write::SimpleFileOptions};

pub struct MockState {
    pub archive: Vec<u8>,
    pub artifact: DownloadArtifact,
    pub ranges: Mutex<Vec<String>>,
    pub truncate_once: AtomicBool,
    pub corrupt_download: AtomicBool,
    session_id: Uuid,
    download_url: String,
    publisher_key: [u8; 32],
}

pub fn host() -> InstallHostProfile {
    let api = HostApiSupport {
        version: "1.0".to_owned(),
        features: vec!["surface.basic".to_owned()],
    };
    InstallHostProfile {
        loom_version: "1.2.0".to_owned(),
        hook_version: "1.2.0".to_owned(),
        platform: "windows-x64".to_owned(),
        loom_capability_api: api.clone(),
        hook_extension_api: api.clone(),
        surface_api: api,
        surface_nodes: vec!["panel".to_owned()],
        frameworks: vec![InstalledFramework {
            id: "neuro/runtime".to_owned(),
            version: "1.4.0".to_owned(),
            ready: true,
        }],
    }
}

pub async fn start_mock() -> (String, Arc<MockState>, tokio::task::JoinHandle<()>) {
    let (archive, canonical, publisher_key) = signed_archive();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let artifact = DownloadArtifact {
        artifact_id: Uuid::new_v4(),
        release_id: Uuid::new_v4(),
        digest: canonical,
        size_bytes: archive.len() as u64,
        media_type: "application/zip".to_owned(),
        file_name: "sample-art-1.0.0.zip".to_owned(),
    };
    let state = Arc::new(MockState {
        archive,
        artifact,
        ranges: Mutex::new(Vec::new()),
        truncate_once: AtomicBool::new(false),
        corrupt_download: AtomicBool::new(false),
        session_id: Uuid::new_v4(),
        download_url: format!("{base}/restricted/package.zip"),
        publisher_key,
    });
    let router = Router::new()
        .route("/v1/me/artifacts/{id}/download-sessions", post(issue))
        .route(
            "/v1/me/download-sessions/{id}/install-challenge",
            post(challenge),
        )
        .route("/v1/me/install-receipts/{id}/verify", post(verify_receipt))
        .route("/restricted/package.zip", get(download))
        .with_state(state.clone());
    let handle = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    (base, state, handle)
}

async fn issue(
    State(state): State<Arc<MockState>>,
    AxumPath(id): AxumPath<Uuid>,
    headers: HeaderMap,
    Json(request): Json<CreateDownloadSessionRequest>,
) -> impl IntoResponse {
    assert_eq!(id, state.artifact.artifact_id);
    assert!(headers.contains_key(header::AUTHORIZATION));
    assert_eq!(
        request.client_type,
        assetlibrary_contracts::DownloadClientType::Loom
    );
    let session = DownloadSession {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        session_id: state.session_id,
        artifact: state.artifact.clone(),
        download_url: state.download_url.clone(),
        access_token: format!("v1.{}", "x".repeat(61)),
        expires_at: (OffsetDateTime::now_utc() + Duration::minutes(10))
            .format(&Rfc3339)
            .unwrap(),
    };
    (
        [(header::CACHE_CONTROL, "no-store")],
        (StatusCode::CREATED, Json(session)),
    )
}

async fn challenge(
    State(state): State<Arc<MockState>>,
    AxumPath(session_id): AxumPath<Uuid>,
    Json(request): Json<CreateInstallChallengeRequest>,
) -> impl IntoResponse {
    assert_eq!(session_id, state.session_id);
    let now = OffsetDateTime::now_utc();
    let host_digest = hex::encode(Sha256::digest(serde_json::to_vec(&request.host).unwrap()));
    let fingerprint = hex::encode(Sha256::digest(state.publisher_key));
    let response = InstallChallenge {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        receipt_id: request.receipt_id,
        download_session_id: session_id,
        client_instance_id: request.client_instance_id,
        package: InstallPackage {
            package_id: Uuid::new_v4(),
            publisher_id: Uuid::new_v4(),
            publisher_slug: "sample-publisher".to_owned(),
            package_slug: "sample-art".to_owned(),
            kind: PackageKind::Art,
            version: "1.0.0".to_owned(),
            permissions: Vec::new(),
        },
        artifact: state.artifact.clone(),
        archive_sha256: hex_digest(&sha256_digest(&state.archive)),
        trusted_signing_key: TrustedPublisherKey {
            key_id: "sample-key".to_owned(),
            algorithm: SigningKeyAlgorithm::Ed25519,
            public_key_base64: STANDARD.encode(state.publisher_key),
            fingerprint: format!("sha256:{fingerprint}"),
        },
        host_profile_sha256: host_digest,
        nonce: Uuid::new_v4(),
        issued_at: now.format(&Rfc3339).unwrap(),
        expires_at: (now + Duration::minutes(30)).format(&Rfc3339).unwrap(),
    };
    (
        [(header::CACHE_CONTROL, "private, no-store")],
        (StatusCode::CREATED, Json(response)),
    )
}

async fn download(State(state): State<Arc<MockState>>, headers: HeaderMap) -> Response<Body> {
    assert_eq!(headers.get(header::ACCEPT_ENCODING).unwrap(), "identity");
    let range = headers
        .get(header::RANGE)
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    state.ranges.lock().unwrap().push(range.clone());
    let start = range
        .strip_prefix("bytes=")
        .unwrap()
        .strip_suffix('-')
        .unwrap()
        .parse::<usize>()
        .unwrap();
    let remaining = &state.archive[start..];
    let mut body = if state.truncate_once.swap(false, Ordering::SeqCst) {
        remaining[..remaining.len() / 2].to_vec()
    } else {
        remaining.to_vec()
    };
    if state.corrupt_download.load(Ordering::SeqCst) && !body.is_empty() {
        body[0] ^= 0xff;
    }
    let end = start + body.len() - 1;
    Response::builder()
        .status(StatusCode::PARTIAL_CONTENT)
        .header(header::CONTENT_LENGTH, body.len())
        .header(
            header::CONTENT_RANGE,
            format!("bytes {start}-{end}/{}", state.archive.len()),
        )
        .body(Body::from(body))
        .unwrap()
}

async fn verify_receipt(
    State(state): State<Arc<MockState>>,
    AxumPath(receipt_id): AxumPath<Uuid>,
    Json(request): Json<VerifyInstallReceiptRequest>,
) -> impl IntoResponse {
    let now = OffsetDateTime::now_utc().format(&Rfc3339).unwrap();
    let receipt = InstallReceipt {
        schema_version: SCHEMA_VERSION_V1.to_owned(),
        receipt_id,
        release_id: state.artifact.release_id,
        artifact_id: state.artifact.artifact_id,
        digest: state.artifact.digest.clone(),
        status: "verified".to_owned(),
        installed_at: OffsetDateTime::from_unix_timestamp(request.installed_at_epoch_seconds)
            .unwrap()
            .format(&Rfc3339)
            .unwrap(),
        verified_at: now,
    };
    (
        [(header::CACHE_CONTROL, "private, no-store")],
        Json(receipt),
    )
}

fn signed_archive() -> (Vec<u8>, String, [u8; 32]) {
    let manifest = json!({
        "id":"sample-art","name":"Sample Art","description":"fixture","enabled":true,
        "execution":{"type":"framework_art","framework":"neuro/runtime"},"inputs":[],"outputs":[],"params":[],
        "metadata":{"art":{"qualifiedId":"sample-publisher/sample-art"},
          "dependencies":{"framework":"neuro/runtime","frameworkVersion":"^1.0"},
          "packageSecurity":{"version":"1.0.0","publisher":{"id":"sample-publisher","keyId":"sample-key"},
            "signature":{"algorithm":"ed25519","keyId":"sample-key","file":"signature.json"}}}
    });
    let entries = vec![("manifest.json", serde_json::to_vec(&manifest).unwrap()),
        ("art.runtime.json", br#"{"protocolVersion":"loom.art.runtime.v1","entry":{"command":"runtime/main.exe","args":[]}}"#.to_vec()),
        ("runtime/main.exe", b"fixture executable".to_vec())];
    let unsigned = zip(&entries);
    let canonical = canonical_zip_digest(&unsigned, None).unwrap();
    let canonical_hex = hex_digest(&canonical);
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let signature = key.sign(canonical_hex.as_bytes());
    let document = json!({"schemaVersion":1,"algorithm":"ed25519","keyId":"sample-key","digestAlgorithm":"sha256",
        "digest":canonical_hex,"signature":STANDARD.encode(signature.to_bytes()),"publicKey":STANDARD.encode(key.verifying_key().to_bytes())});
    let mut signed_entries = entries;
    signed_entries.push(("signature.json", serde_json::to_vec(&document).unwrap()));
    let signed = zip(&signed_entries);
    (
        signed,
        hex_digest(&canonical),
        key.verifying_key().to_bytes(),
    )
}

fn zip(entries: &[(&str, Vec<u8>)]) -> Vec<u8> {
    let mut output = Cursor::new(Vec::new());
    let mut writer = ZipWriter::new(&mut output);
    for (name, bytes) in entries {
        writer
            .start_file(*name, SimpleFileOptions::default())
            .unwrap();
        writer.write_all(bytes).unwrap();
    }
    writer.finish().unwrap();
    output.into_inner()
}
