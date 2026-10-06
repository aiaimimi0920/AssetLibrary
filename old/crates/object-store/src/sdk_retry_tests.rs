use super::{ObjectStore, ObjectStoreError, S3ObjectStore};
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region, retry::RetryConfig};
use aws_sdk_s3::presigning::PresigningConfig;
use aws_smithy_async::time::StaticTimeSource;
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;
use std::time::{Duration, SystemTime};

const LOCAL_TIME: u64 = 1_696_118_400;
const LOCAL_SIGNING_TIME: &str = "20231001T000000Z";
const SERVICE_SIGNING_TIME: &str = "20231001T001000Z";
const SKEWED_DATE: &str = "Date: Sun, 01 Oct 2023 00:10:00 GMT\r\n";

struct Server {
    endpoint: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    task: Option<JoinHandle<()>>,
}

impl Server {
    fn new(responses: Vec<String>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(Vec::new()));
        let stop = Arc::new(AtomicBool::new(false));
        let captured = requests.clone();
        let stopping = stop.clone();
        let task = std::thread::spawn(move || {
            let mut responses = responses.into_iter();
            while !stopping.load(Ordering::Relaxed) {
                let (mut stream, _) = match listener.accept() {
                    Ok(connection) => connection,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(1));
                        continue;
                    }
                    Err(error) => panic!("loopback accept failed: {error}"),
                };
                // Accepted sockets can inherit the listener's nonblocking mode on Windows.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                let mut request = Vec::new();
                let mut buffer = [0; 1024];
                while !request.windows(4).any(|part| part == b"\r\n\r\n") {
                    let count = stream.read(&mut buffer).unwrap();
                    assert!(count > 0 && request.len() + count <= 16 * 1024);
                    request.extend_from_slice(&buffer[..count]);
                }
                captured
                    .lock()
                    .unwrap()
                    .push(String::from_utf8(request).unwrap());
                let response = responses.next().expect("unexpected extra SDK request");
                stream.write_all(response.as_bytes()).unwrap();
            }
        });
        Self {
            endpoint,
            requests,
            stop,
            task: Some(task),
        }
    }

    fn store(&self) -> S3ObjectStore {
        // Explicit synthetic credentials and time avoid profiles, metadata, and external services.
        let config = aws_sdk_s3::Config::builder()
            .behavior_version(BehaviorVersion::latest())
            .credentials_provider(Credentials::new(
                "synthetic-access",
                "synthetic-secret",
                None,
                None,
                "test",
            ))
            .region(Region::new("auto"))
            .endpoint_url(&self.endpoint)
            .force_path_style(true)
            .time_source(StaticTimeSource::from_secs(LOCAL_TIME))
            .retry_config(RetryConfig::standard().with_initial_backoff(Duration::from_millis(1)))
            .build();
        S3ObjectStore {
            client: aws_sdk_s3::Client::from_conf(config),
            quarantine_bucket: "quarantine".into(),
            published_bucket: "published".into(),
            r2_multipart: false,
        }
    }

    fn signing_times(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                assert!(request.starts_with("GET /quarantine/fixture.bin?x-id=GetObject "));
                request
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        name.eq_ignore_ascii_case("x-amz-date")
                            .then(|| value.trim().to_owned())
                    })
                    .expect("every object request must be signed")
            })
            .collect()
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if self.task.take().unwrap().join().is_err() && !std::thread::panicking() {
            panic!("loopback server failed");
        }
    }
}

fn response(status: &str, headers: &str, body: &str) -> String {
    format!(
        "HTTP/1.1 {status}\r\n{headers}Content-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

fn denied(headers: &str, code: &str) -> String {
    response(
        "403 Forbidden",
        headers,
        &format!("<Error><Code>{code}</Code><Message>synthetic fixture</Message></Error>"),
    )
}

async fn download(
    store: &S3ObjectStore,
    destination: &std::path::Path,
) -> Result<u64, ObjectStoreError> {
    tokio::time::timeout(
        Duration::from_secs(5),
        store.download_quarantine_object("fixture.bin", destination, 7),
    )
    .await
    .expect("SDK retry handling must remain bounded")
}

#[tokio::test]
async fn clock_skew_retry_corrects_signing_and_preserves_offline_presigning() {
    let server = Server::new(vec![
        denied(SKEWED_DATE, "SignatureDoesNotMatch"),
        response("200 OK", SKEWED_DATE, "fixture"),
        response("200 OK", SKEWED_DATE, "fixture"),
    ]);
    let store = server.store();
    let directory = tempfile::tempdir().unwrap();
    for name in ["first", "second"] {
        let destination = directory.path().join(name);
        assert_eq!(download(&store, &destination).await.unwrap(), 7);
        assert_eq!(std::fs::read(destination).unwrap(), b"fixture");
    }
    assert_eq!(
        server.signing_times(),
        [
            LOCAL_SIGNING_TIME,
            SERVICE_SIGNING_TIME,
            SERVICE_SIGNING_TIME
        ]
    );
    let request = store
        .client
        .upload_part()
        .bucket("quarantine")
        .key("fixture.bin")
        .upload_id("synthetic-upload")
        .part_number(1)
        .content_length(7)
        .checksum_sha256(STANDARD.encode([0xab; 32]))
        .presigned(
            PresigningConfig::builder()
                .start_time(SystemTime::UNIX_EPOCH + Duration::from_secs(LOCAL_TIME))
                .expires_in(Duration::from_secs(900))
                .build()
                .unwrap(),
        )
        .await
        .unwrap();
    let url = url::Url::parse(request.uri()).unwrap();
    let signing_time = url
        .query_pairs()
        .find(|(key, _)| key == "X-Amz-Date")
        .unwrap()
        .1
        .into_owned();
    assert_eq!(signing_time, LOCAL_SIGNING_TIME);
    assert_eq!(
        server.signing_times().len(),
        3,
        "presigning must not contact S3"
    );
}

#[tokio::test]
async fn repeated_clock_skew_failure_obeys_retry_budget_and_leaves_no_file() {
    let server = Server::new(vec![denied(SKEWED_DATE, "SignatureDoesNotMatch"); 4]);
    let directory = tempfile::tempdir().unwrap();
    let destination = directory.path().join("rejected");
    assert!(matches!(
        download(&server.store(), &destination).await,
        Err(ObjectStoreError::RequestFailed)
    ));
    assert_eq!(
        server.signing_times(),
        [
            LOCAL_SIGNING_TIME,
            SERVICE_SIGNING_TIME,
            SERVICE_SIGNING_TIME
        ]
    );
    assert!(!destination.exists());
}

#[tokio::test]
async fn untrusted_dates_and_ordinary_denials_do_not_become_clock_skew_retries() {
    for (headers, code) in [
        ("", "SignatureDoesNotMatch"),
        ("Date: invalid\r\n", "SignatureDoesNotMatch"),
        (
            "Date: Sun, 01 Oct 2023 00:10:00 GMT\r\nAge: 0\r\n",
            "SignatureDoesNotMatch",
        ),
        (
            "Date: Sun, 01 Oct 2023 00:04:00 GMT\r\n",
            "SignatureDoesNotMatch",
        ),
        (SKEWED_DATE, "AccessDenied"),
    ] {
        let server = Server::new(vec![denied(headers, code); 4]);
        let directory = tempfile::tempdir().unwrap();
        let destination = directory.path().join("rejected");
        assert!(matches!(
            download(&server.store(), &destination).await,
            Err(ObjectStoreError::RequestFailed)
        ));
        assert_eq!(server.signing_times(), [LOCAL_SIGNING_TIME]);
        assert!(!destination.exists());
    }
}
