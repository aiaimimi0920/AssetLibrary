use super::*;
use crate::{inspection_executor::InspectionExecutor, local_inspection::InspectionFailure};
use tokio::time::{sleep, timeout};

const WAIT: Duration = Duration::from_secs(5);

fn request() -> InspectionRequest {
    InspectionRequest {
        kind: "art".into(),
        publisher_slug: "fixture".into(),
        package_slug: "fixture".into(),
        version: "1.0.0".into(),
        permissions: vec![],
        size_bytes: 0,
        expected_digest: format!("sha256:{}", "00".repeat(32)),
    }
}

fn fixture_command(mode: &str) -> Command {
    let mut command = isolated_command(&std::env::current_exe().unwrap());
    command.args([
        "--exact",
        "inspection_process::tests::child_fixture",
        "--ignored",
        "--nocapture",
    ]);
    command.env("ASSETLIBRARY_TEST_CHILD", mode);
    command
}

#[test]
#[ignore = "subprocess fixture explicitly executed by the lifecycle tests"]
fn child_fixture() {
    let mode = std::env::var("ASSETLIBRARY_TEST_CHILD").unwrap();
    assert!(std::env::var_os("DATABASE_URL").is_none());
    assert!(std::env::var_os("AWS_SECRET_ACCESS_KEY").is_none());
    std::fs::write("child.pid", std::process::id().to_string()).unwrap();
    match mode.as_str() {
        "stall" => {
            std::thread::sleep(Duration::from_secs(10));
            std::fs::write("late-result", b"must not be reached").unwrap();
        }
        "valid" => {
            let result: InspectionResult = Err(InspectionFailure::ManifestInvalid);
            write_json(Path::new(RESULT_FILE), &result, RESULT_LIMIT).unwrap();
        }
        "malformed" => std::fs::write(RESULT_FILE, b"not JSON").unwrap(),
        "unknown" => std::fs::write(RESULT_FILE, br#"{"Err":"unrecognized_failure"}"#).unwrap(),
        "oversize" => File::create(RESULT_FILE)
            .unwrap()
            .set_len(RESULT_LIMIT + 1)
            .unwrap(),
        "crash" => {
            std::fs::write(RESULT_FILE, b"partial result").unwrap();
            std::process::exit(17);
        }
        _ => panic!("unsupported fixture mode"),
    }
}

#[tokio::test]
async fn timeout_kills_reaps_cleans_and_allows_the_next_inspection() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let directory = workspace.archive_path().parent().unwrap().to_owned();
    let mut work = Box::pin(inspect_with_command(
        workspace,
        request(),
        fixture_command("stall"),
    ));
    let ready = async {
        timeout(WAIT, async {
            while !directory.join("child.pid").exists() {
                sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
    };
    tokio::select! {
        result = &mut work => panic!("child ended before cancellation: {}", result.is_ok()),
        _ = ready => {}
    }
    assert!(directory.exists());
    assert!(
        timeout(Duration::from_millis(30), executor.wait_until_idle())
            .await
            .is_err()
    );
    assert!(timeout(Duration::from_millis(30), work).await.is_err());
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
    assert!(!directory.exists(), "cleanup must follow child reaping");
    let next = executor.reserve(root.path()).await.unwrap();
    let (next, result) = timeout(
        WAIT,
        inspect_with_command(next, request(), fixture_command("valid")),
    )
    .await
    .unwrap()
    .unwrap();
    assert!(matches!(result, Err(InspectionFailure::ManifestInvalid)));
    assert!(next.archive_path().parent().unwrap().exists());
    drop(next);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn child_failures_and_invalid_protocol_never_return_a_verified_result() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    for mode in ["crash", "malformed", "unknown", "oversize"] {
        let workspace = executor.reserve(root.path()).await.unwrap();
        let result = timeout(
            WAIT,
            inspect_with_command(workspace, request(), fixture_command(mode)),
        )
        .await
        .unwrap();
        assert!(result.is_err(), "accepted {mode}");
        timeout(WAIT, executor.wait_until_idle()).await.unwrap();
        assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn spawn_failure_and_oversized_request_release_the_workspace() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let missing = isolated_command(&root.path().join("missing-inspector"));
    assert!(
        inspect_with_command(workspace, request(), missing)
            .await
            .is_err()
    );
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let mut oversized = request();
    oversized.package_slug = "x".repeat(REQUEST_LIMIT as usize);
    assert!(
        inspect_with_command(workspace, oversized, fixture_command("stall"))
            .await
            .is_err()
    );
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[test]
fn cancellation_before_spawn_never_starts_a_child() {
    let root = tempfile::tempdir().unwrap();
    let mut command = fixture_command("stall");
    command.current_dir(root.path());
    assert!(supervise(command, &AtomicBool::new(true)).is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}
