use async_trait::async_trait;
use std::{
    path::PathBuf,
    sync::{
        Mutex,
        atomic::{AtomicUsize, Ordering},
    },
};
use tempfile::TempDir;
use time::OffsetDateTime;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    AccountBearer, ClientConfig, ClientError, DownloadOrigin, InstallCommit, InstallTarget,
    LoomApiClient, LoomDownloadSession, LoomInstaller, PendingReceipt, ReceiptProofKey,
    ReceiptQueue, ReceiptSync, ResumableDownloader, VerifiedPackage,
    test_support::{MockState, host, start_mock},
};

#[derive(Default)]
struct RecordingTarget {
    calls: AtomicUsize,
    archive: Mutex<Option<PathBuf>>,
}

#[async_trait]
impl InstallTarget for RecordingTarget {
    type Transaction = ();

    async fn prepare(&self, package: &VerifiedPackage) -> Result<Self::Transaction, ClientError> {
        assert_eq!(package.manifest()["id"], "sample-art");
        assert!(package.archive_path().exists());
        *self.archive.lock().unwrap() = Some(package.archive_path().to_owned());
        Ok(())
    }

    async fn commit(
        &self,
        _transaction: &mut Self::Transaction,
    ) -> Result<InstallCommit, ClientError> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        Ok(InstallCommit {
            installed_at_epoch_seconds: OffsetDateTime::now_utc().unix_timestamp(),
        })
    }

    async fn finalize(&self, _transaction: &mut Self::Transaction) -> Result<(), ClientError> {
        Ok(())
    }

    async fn rollback(&self, _transaction: Self::Transaction) -> Result<(), ClientError> {
        Ok(())
    }
}

struct RollbackTarget {
    active: Mutex<String>,
    rollbacks: AtomicUsize,
}

#[async_trait]
impl InstallTarget for RollbackTarget {
    type Transaction = String;

    async fn prepare(&self, _package: &VerifiedPackage) -> Result<Self::Transaction, ClientError> {
        Ok(self.active.lock().unwrap().clone())
    }

    async fn commit(
        &self,
        _transaction: &mut Self::Transaction,
    ) -> Result<InstallCommit, ClientError> {
        *self.active.lock().unwrap() = "new".to_owned();
        Err(ClientError::Install("activation failed".to_owned()))
    }

    async fn finalize(&self, _transaction: &mut Self::Transaction) -> Result<(), ClientError> {
        Ok(())
    }

    async fn rollback(&self, transaction: Self::Transaction) -> Result<(), ClientError> {
        *self.active.lock().unwrap() = transaction;
        self.rollbacks.fetch_add(1, Ordering::SeqCst);
        Ok(())
    }
}

#[tokio::test]
async fn resumes_verifies_installs_and_queues_non_secret_receipt() {
    let (base, state, server) = start_mock().await;
    let origin = DownloadOrigin::parse(&base, true).unwrap();
    let config = ClientConfig::new(&base, [origin], true).unwrap();
    let api = LoomApiClient::new(config).unwrap();
    let account = AccountBearer::new("opaque-account-token").unwrap();
    let session = api
        .create_download_session(&account, state.artifact.artifact_id, "download-key-0001")
        .await
        .unwrap();
    assert!(!format!("{session:?}").contains(&"x".repeat(32)));

    let host = host();
    let (proof, challenge_request) =
        ReceiptProofKey::generate(Uuid::new_v4(), host.clone()).unwrap();
    let challenge = api
        .create_install_challenge(
            &account,
            session.session_id,
            "challenge-key-0001",
            &challenge_request,
        )
        .await
        .unwrap();
    let pending = proof.bind(&session, challenge).unwrap();
    let cache = TempDir::new().unwrap();
    seed_partial(cache.path(), &state.artifact.digest, &state.archive).await;
    state.truncate_once.store(true, Ordering::SeqCst);
    let installer = LoomInstaller::new(api.clone(), cache.path());
    let target = RecordingTarget::default();
    let outcome = installer
        .install(
            &session,
            pending,
            &host,
            &target,
            "receipt-key-0001".to_owned(),
            None,
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

    assert_eq!(target.calls.load(Ordering::SeqCst), 1);
    assert!(
        outcome
            .package
            .archive_path()
            .starts_with(cache.path().join("verified"))
    );
    {
        let ranges = state.ranges.lock().unwrap();
        assert_eq!(ranges.len(), 2);
        assert_eq!(ranges[0], format!("bytes={}-", state.archive.len() / 3));
        assert_ne!(ranges[0], ranges[1]);
    }
    let queued = match outcome.receipt {
        ReceiptSync::Pending { receipt, .. } => receipt,
        ReceiptSync::Synced(_) => panic!("account-free install must queue its receipt"),
    };
    assert!(queued.validate());
    let durable = serde_json::to_string(&queued).unwrap();
    assert!(!durable.contains("opaque-account-token"));
    assert!(!durable.contains("v1.x"));
    let queue_root = TempDir::new().unwrap();
    let queue = ReceiptQueue::new(queue_root.path());
    queue.enqueue(&queued).await.unwrap();
    queue.enqueue(&queued).await.unwrap();
    assert_eq!(queue.pending().await.unwrap().len(), 1);
    let report = queue.flush(&api, &account).await.unwrap();
    assert_eq!(report.synced.len(), 1);
    assert!(report.pending.is_empty());
    assert_eq!(report.synced[0].artifact_id, state.artifact.artifact_id);
    assert!(queue.pending().await.unwrap().is_empty());
    server.abort();
}

#[tokio::test]
async fn rejects_download_origin_outside_the_allowlist() {
    let (base, state, server) = start_mock().await;
    let config = ClientConfig::new(
        &base,
        [DownloadOrigin::parse("http://127.0.0.1:9", true).unwrap()],
        true,
    )
    .unwrap();
    let api = LoomApiClient::new(config).unwrap();
    let account = AccountBearer::new("opaque-account-token").unwrap();
    let session = api
        .create_download_session(&account, state.artifact.artifact_id, "download-key-0002")
        .await
        .unwrap();
    let host = host();
    let (proof, request) = ReceiptProofKey::generate(Uuid::new_v4(), host.clone()).unwrap();
    let challenge = api
        .create_install_challenge(&account, session.session_id, "challenge-key-0002", &request)
        .await
        .unwrap();
    let pending = proof.bind(&session, challenge).unwrap();
    let result = LoomInstaller::new(api, TempDir::new().unwrap().path())
        .install(
            &session,
            pending,
            &host,
            &RecordingTarget::default(),
            "receipt-key-0002".to_owned(),
            None,
            &CancellationToken::new(),
            None,
        )
        .await;
    assert!(matches!(result, Err(ClientError::DownloadOriginDenied)));
    server.abort();
}

#[tokio::test]
async fn failed_activation_rolls_back_to_the_previous_installation() {
    let (base, state, server) = start_mock().await;
    let (api, session, host, pending) = install_inputs(&base, &state, "rollback").await;
    let target = RollbackTarget {
        active: Mutex::new("previous".to_owned()),
        rollbacks: AtomicUsize::new(0),
    };
    let result = LoomInstaller::new(api, TempDir::new().unwrap().path())
        .install(
            &session,
            pending,
            &host,
            &target,
            "receipt-rollback-0001".to_owned(),
            None,
            &CancellationToken::new(),
            None,
        )
        .await;

    assert!(matches!(result, Err(ClientError::Install(_))));
    assert_eq!(*target.active.lock().unwrap(), "previous");
    assert_eq!(target.rollbacks.load(Ordering::SeqCst), 1);
    server.abort();
}

#[tokio::test]
async fn corrupt_download_never_reaches_the_install_target() {
    let (base, state, server) = start_mock().await;
    state.corrupt_download.store(true, Ordering::SeqCst);
    let (api, session, host, pending) = install_inputs(&base, &state, "corrupt").await;
    let target = RecordingTarget::default();
    let result = LoomInstaller::new(api, TempDir::new().unwrap().path())
        .install(
            &session,
            pending,
            &host,
            &target,
            "receipt-corrupt-0001".to_owned(),
            None,
            &CancellationToken::new(),
            None,
        )
        .await;

    assert!(matches!(result, Err(ClientError::ArchiveDigestMismatch)));
    assert_eq!(target.calls.load(Ordering::SeqCst), 0);
    assert!(target.archive.lock().unwrap().is_none());
    server.abort();
}

#[tokio::test]
async fn preauthorized_verified_cache_installs_offline_and_defers_receipt() {
    let (base, state, server) = start_mock().await;
    let origin = DownloadOrigin::parse(&base, true).unwrap();
    let api = LoomApiClient::new(ClientConfig::new(&base, [origin], true).unwrap()).unwrap();
    let account = AccountBearer::new("opaque-account-token").unwrap();
    let session = api
        .create_download_session(
            &account,
            state.artifact.artifact_id,
            "download-offline-0001",
        )
        .await
        .unwrap();
    let host = host();
    let (proof, request) = ReceiptProofKey::generate(Uuid::new_v4(), host.clone()).unwrap();
    let challenge = api
        .create_install_challenge(
            &account,
            session.session_id,
            "challenge-offline-0001",
            &request,
        )
        .await
        .unwrap();
    let cache = TempDir::new().unwrap();
    ResumableDownloader::new(api.clone(), cache.path())
        .download_and_verify(&session, &challenge, &host, &CancellationToken::new(), None)
        .await
        .unwrap();
    let pending = proof.bind(&session, challenge).unwrap();
    server.abort();
    tokio::task::yield_now().await;

    let target = RecordingTarget::default();
    let outcome = LoomInstaller::new(api, cache.path())
        .install(
            &session,
            pending,
            &host,
            &target,
            "receipt-offline-0001".to_owned(),
            None,
            &CancellationToken::new(),
            None,
        )
        .await
        .unwrap();

    assert_eq!(target.calls.load(Ordering::SeqCst), 1);
    assert!(matches!(outcome.receipt, ReceiptSync::Pending { .. }));
}

async fn install_inputs(
    base: &str,
    state: &MockState,
    suffix: &str,
) -> (
    LoomApiClient,
    LoomDownloadSession,
    assetlibrary_contracts::InstallHostProfile,
    PendingReceipt,
) {
    let origin = DownloadOrigin::parse(base, true).unwrap();
    let api = LoomApiClient::new(ClientConfig::new(base, [origin], true).unwrap()).unwrap();
    let account = AccountBearer::new("opaque-account-token").unwrap();
    let download_key = format!("download-{suffix}-0001");
    let session = api
        .create_download_session(&account, state.artifact.artifact_id, &download_key)
        .await
        .unwrap();
    let host = host();
    let (proof, request) = ReceiptProofKey::generate(Uuid::new_v4(), host.clone()).unwrap();
    let challenge_key = format!("challenge-{suffix}-0001");
    let challenge = api
        .create_install_challenge(&account, session.session_id, &challenge_key, &request)
        .await
        .unwrap();
    let pending = proof.bind(&session, challenge).unwrap();
    (api, session, host, pending)
}

async fn seed_partial(root: &std::path::Path, digest: &str, archive: &[u8]) {
    let directory = root.join("partial");
    tokio::fs::create_dir_all(&directory).await.unwrap();
    tokio::fs::write(
        directory.join(format!("{digest}.part")),
        &archive[..archive.len() / 3],
    )
    .await
    .unwrap();
}
