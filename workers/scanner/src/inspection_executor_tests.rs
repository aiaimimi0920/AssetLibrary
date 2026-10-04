use super::InspectionExecutor;
use assetlibrary_supply_chain::{canonical_zip_digest, canonical_zip_digest_file};
use std::{io::Write, sync::Arc, sync::atomic::AtomicBool, sync::atomic::Ordering, time::Duration};
use tokio::{sync::oneshot, time::timeout};

const WAIT: Duration = Duration::from_secs(5);
const BLOCKED: Duration = Duration::from_millis(30);

#[tokio::test]
async fn real_archive_result_keeps_workspace_until_verification_finishes() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let path = workspace.archive_path();
    let mut zip = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    zip.start_file(
        "assets/readme.txt",
        zip::write::SimpleFileOptions::default(),
    )
    .unwrap();
    zip.write_all(b"harmless scanner lifecycle fixture")
        .unwrap();
    let bytes = zip.finish().unwrap().into_inner();
    let expected = canonical_zip_digest(&bytes, None).unwrap();
    std::fs::write(&path, bytes).unwrap();
    let (workspace, result) = workspace
        .inspect(|path| canonical_zip_digest_file(path, None))
        .await
        .unwrap();
    assert_eq!(result.unwrap(), expected);
    assert!(path.exists());
    assert!(timeout(BLOCKED, executor.wait_until_idle()).await.is_err());
    drop(workspace);
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
    assert!(!path.parent().unwrap().exists());
}

#[tokio::test]
async fn timed_out_inspection_keeps_files_and_blocks_the_next_job_until_thread_exit() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let path = workspace.archive_path();
    std::fs::write(&path, b"still owned by the blocking inspector").unwrap();
    let (started, ready) = oneshot::channel();
    let (release, resumed) = std::sync::mpsc::channel();
    let inspected = Arc::new(AtomicBool::new(false));
    let promoted = Arc::new(AtomicBool::new(false));
    let inspected_in_thread = inspected.clone();
    let promoted_by_caller = promoted.clone();
    let mut work = Box::pin(async move {
        let result = workspace
            .inspect(move |path| {
                started.send(()).unwrap();
                resumed.recv_timeout(WAIT).unwrap();
                assert_eq!(
                    std::fs::read(path).unwrap(),
                    b"still owned by the blocking inspector"
                );
                inspected_in_thread.store(true, Ordering::SeqCst);
            })
            .await;
        // This continuation models signature verification/promotion. A late
        // blocking result must never resume the cancelled pipeline.
        promoted_by_caller.store(true, Ordering::SeqCst);
        result
    });
    tokio::select! {
        result = &mut work => panic!("inspection completed before release: {}", result.is_ok()),
        result = ready => result.unwrap(),
    }
    assert!(timeout(BLOCKED, work).await.is_err());
    assert!(
        path.exists(),
        "cancelling the waiter must not delete the archive"
    );
    assert!(
        timeout(BLOCKED, executor.reserve(root.path()))
            .await
            .is_err()
    );
    assert!(timeout(BLOCKED, executor.wait_until_idle()).await.is_err());
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 1);
    release.send(()).unwrap();
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
    assert!(inspected.load(Ordering::SeqCst));
    assert!(!promoted.load(Ordering::SeqCst));
    assert!(!path.parent().unwrap().exists());
    let next = timeout(WAIT, executor.reserve(root.path()))
        .await
        .unwrap()
        .unwrap();
    assert!(next.archive_path().parent().unwrap().exists());
    drop(next);
    assert_eq!(std::fs::read_dir(root.path()).unwrap().count(), 0);
}

#[tokio::test]
async fn inspection_panic_releases_files_and_admission_slot() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let path = workspace.archive_path();
    std::fs::write(&path, b"panic fixture").unwrap();
    let result = workspace
        .inspect::<(), _>(|_| panic!("fixture panic"))
        .await;
    assert!(matches!(result, Err(error) if error.is_panic()));
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
    assert!(!path.parent().unwrap().exists());
}

#[tokio::test]
async fn failed_workspace_creation_does_not_leak_the_slot() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("not-a-directory");
    std::fs::write(&file, b"fixture").unwrap();
    let executor = InspectionExecutor::new();
    assert!(executor.reserve(&file).await.is_err());
    let workspace = timeout(WAIT, executor.reserve(root.path()))
        .await
        .unwrap()
        .unwrap();
    drop(workspace);
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
}

#[tokio::test]
async fn failed_archive_result_and_preinspection_cancellation_clean_up() {
    let root = tempfile::tempdir().unwrap();
    let executor = InspectionExecutor::new();
    let workspace = executor.reserve(root.path()).await.unwrap();
    let path = workspace.archive_path();
    std::fs::write(&path, b"not a ZIP").unwrap();
    let (workspace, result) = workspace
        .inspect(|path| canonical_zip_digest_file(path, None))
        .await
        .unwrap();
    assert!(result.is_err());
    drop(workspace);
    assert!(!path.parent().unwrap().exists());
    let cancelled = executor.reserve(root.path()).await.unwrap();
    let cancelled_path = cancelled.archive_path();
    drop(cancelled);
    assert!(!cancelled_path.parent().unwrap().exists());
    timeout(WAIT, executor.wait_until_idle()).await.unwrap();
}
