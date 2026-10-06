use assetlibrary_object_store::{ObjectStore, ObjectStoreConfig, S3ObjectStore};
use base64::{Engine as _, engine::general_purpose::STANDARD};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const CHILD: &str = "ASSETLIBRARY_SDK_CONFIG_PROBE";
const PROBE_OK: &str = "ASSETLIBRARY_SDK_CONFIG_PROBE_OK";

#[test]
fn isolated_config_loads_synthetic_credentials_and_presigns() {
    if std::env::var(CHILD).is_ok_and(|value| value == "1") {
        run_probe();
        println!("{PROBE_OK}");
        return;
    }

    // Never read a developer's AWS profiles or use ambient credentials/metadata.
    let home = tempfile::tempdir().unwrap();
    let config = home.path().join("config");
    let credentials = home.path().join("credentials");
    std::fs::write(&config, "").unwrap();
    std::fs::write(&credentials, "").unwrap();
    let mut command = Command::new(std::env::current_exe().unwrap());
    command
        .args([
            "--exact",
            "isolated_config_loads_synthetic_credentials_and_presigns",
            "--nocapture",
        ])
        .env_clear()
        .env(CHILD, "1")
        .env("HOME", home.path())
        .env("USERPROFILE", home.path())
        .env("AWS_CONFIG_FILE", config)
        .env("AWS_SHARED_CREDENTIALS_FILE", credentials)
        .env("AWS_EC2_METADATA_DISABLED", "true")
        .env("AWS_ACCESS_KEY_ID", "synthetic-test-access")
        .env("AWS_SECRET_ACCESS_KEY", "synthetic-test-secret")
        .current_dir(home.path())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Windows process initialization may need this OS path; no AWS/user settings pass through.
    if let Some(root) = std::env::var_os("SystemRoot") {
        command.env("SystemRoot", root);
    }
    let mut child = command.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    while child.try_wait().unwrap().is_none() {
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("isolated AWS configuration probe timed out");
        }
        std::thread::sleep(Duration::from_millis(20));
    }
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains(PROBE_OK));
}

fn run_probe() {
    assert!(std::env::var("AWS_ACCESS_KEY_ID").is_ok_and(|value| value == "synthetic-test-access"));
    assert!(
        std::env::var("AWS_SECRET_ACCESS_KEY").is_ok_and(|value| value == "synthetic-test-secret")
    );
    assert!(std::env::var("AWS_EC2_METADATA_DISABLED").is_ok_and(|value| value == "true"));
    assert!(std::env::var_os("AWS_SESSION_TOKEN").is_none());
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(async {
            tokio::time::timeout(Duration::from_secs(5), async {
                for (endpoint, is_r2) in [
                    ("http://127.0.0.1:9", false),
                    ("https://synthetic-test.r2.cloudflarestorage.com", true),
                ] {
                    let store = S3ObjectStore::new(ObjectStoreConfig {
                        endpoint_url: Some(endpoint.into()),
                        region: "auto".into(),
                        quarantine_bucket: "quarantine".into(),
                        published_bucket: "published".into(),
                        force_path_style: true,
                    })
                    .await
                    .unwrap();
                    let checksum = STANDARD.encode([0xab; 32]);
                    // Presigning constructs a URL; it never sends an object request.
                    let request = store
                        .presign_upload_part("test.bin", "synthetic-upload", 1, 3, &checksum)
                        .await
                        .unwrap();
                    assert_eq!(request.method, "PUT");
                    let url = url::Url::parse(&request.url).unwrap();
                    assert_eq!(
                        url.host_str(),
                        url::Url::parse(endpoint).unwrap().host_str()
                    );
                    assert_eq!(url.path(), "/quarantine/test.bin");
                    let credentials = url
                        .query_pairs()
                        .find(|(key, _)| key == "X-Amz-Credential")
                        .unwrap()
                        .1;
                    assert!(credentials.starts_with("synthetic-test-access/"));
                    assert!(credentials.ends_with("/auto/s3/aws4_request"));
                    if is_r2 {
                        assert_eq!(request.headers["x-amz-content-sha256"], "ab".repeat(32));
                        assert!(!request.headers.contains_key("x-amz-checksum-sha256"));
                    } else {
                        assert_eq!(request.headers["x-amz-checksum-sha256"], checksum);
                    }
                }
            })
            .await
            .expect(
                "configuration and offline signing must finish without metadata or service calls",
            );
        });
}
