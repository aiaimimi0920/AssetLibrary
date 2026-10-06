use assetlibrary_contracts::{InstallHostProfile, InstallReceipt};
use async_trait::async_trait;
use std::path::PathBuf;
use tokio_util::sync::CancellationToken;

use crate::{
    AccountBearer, ClientError, LoomApiClient, LoomDownloadSession, PendingReceipt,
    ProgressObserver, QueuedReceipt, ResumableDownloader, VerifiedPackage,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InstallCommit {
    pub installed_at_epoch_seconds: i64,
}

#[async_trait]
pub trait InstallTarget: Send + Sync {
    type Transaction: Send;

    /// Stage immutable content without changing the active installation; self-clean on error.
    async fn prepare(&self, package: &VerifiedPackage) -> Result<Self::Transaction, ClientError>;

    /// Atomically activate the staged package while retaining the previous installation.
    async fn commit(
        &self,
        transaction: &mut Self::Transaction,
    ) -> Result<InstallCommit, ClientError>;

    /// Delete staging and the retained backup after local commit checks have passed.
    async fn finalize(&self, transaction: &mut Self::Transaction) -> Result<(), ClientError>;

    /// Restore the previous installation and remove staging. Must be idempotent.
    async fn rollback(&self, transaction: Self::Transaction) -> Result<(), ClientError>;
}

#[derive(Debug)]
pub enum ReceiptPendingReason {
    AccountUnavailable,
    AuthenticationRequired,
    Retryable,
    Rejected(u16),
}

#[derive(Debug)]
pub enum ReceiptSync {
    Synced(InstallReceipt),
    Pending {
        receipt: QueuedReceipt,
        reason: ReceiptPendingReason,
    },
}

#[derive(Debug)]
pub struct InstallOutcome {
    pub package: VerifiedPackage,
    pub commit: InstallCommit,
    pub receipt: ReceiptSync,
}

#[derive(Clone)]
pub struct LoomInstaller {
    api: LoomApiClient,
    downloader: ResumableDownloader,
}

impl LoomInstaller {
    pub fn new(api: LoomApiClient, cache_root: impl Into<PathBuf>) -> Self {
        let downloader = ResumableDownloader::new(api.clone(), cache_root);
        Self { api, downloader }
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn install<T: InstallTarget>(
        &self,
        session: &LoomDownloadSession,
        pending_receipt: PendingReceipt,
        host: &InstallHostProfile,
        target: &T,
        receipt_idempotency_key: String,
        account: Option<&AccountBearer>,
        cancellation: &CancellationToken,
        observer: Option<&ProgressObserver>,
    ) -> Result<InstallOutcome, ClientError> {
        if !valid_idempotency_key(&receipt_idempotency_key) {
            return Err(ClientError::InvalidInput("invalid receipt idempotency key"));
        }
        let challenge = pending_receipt.challenge().clone();
        let package = self
            .downloader
            .download_and_verify(session, &challenge, host, cancellation, observer)
            .await?;
        if cancellation.is_cancelled() {
            return Err(ClientError::Cancelled);
        }
        let mut transaction = target.prepare(&package).await?;
        if cancellation.is_cancelled() {
            return Err(rollback(target, transaction, ClientError::Cancelled).await);
        }
        let commit = match target.commit(&mut transaction).await {
            Ok(commit) => commit,
            Err(error) => return Err(rollback(target, transaction, error).await),
        };
        if commit.installed_at_epoch_seconds <= 0 {
            return Err(rollback(
                target,
                transaction,
                ClientError::Install("installer returned an invalid completion time".to_owned()),
            )
            .await);
        }
        if cancellation.is_cancelled() {
            return Err(rollback(target, transaction, ClientError::Cancelled).await);
        }
        let queued = match pending_receipt
            .sign(commit.installed_at_epoch_seconds, receipt_idempotency_key)
        {
            Ok(receipt) => receipt,
            Err(error) => return Err(rollback(target, transaction, error).await),
        };
        if let Err(error) = target.finalize(&mut transaction).await {
            return Err(rollback(target, transaction, error).await);
        }
        let receipt = match account {
            None => ReceiptSync::Pending {
                receipt: queued,
                reason: ReceiptPendingReason::AccountUnavailable,
            },
            Some(account) => match queued.submit(&self.api, account).await {
                Ok(receipt) => ReceiptSync::Synced(receipt),
                Err(error) => {
                    let reason = pending_reason(&error);
                    ReceiptSync::Pending {
                        receipt: queued,
                        reason,
                    }
                }
            },
        };
        Ok(InstallOutcome {
            package,
            commit,
            receipt,
        })
    }
}

async fn rollback<T: InstallTarget>(
    target: &T,
    transaction: T::Transaction,
    original: ClientError,
) -> ClientError {
    match target.rollback(transaction).await {
        Ok(()) => original,
        Err(_) => ClientError::RollbackFailed,
    }
}

fn pending_reason(error: &ClientError) -> ReceiptPendingReason {
    match error {
        ClientError::HttpStatus(401) => ReceiptPendingReason::AuthenticationRequired,
        ClientError::HttpStatus(status) => ReceiptPendingReason::Rejected(*status),
        error if error.is_retryable() => ReceiptPendingReason::Retryable,
        _ => ReceiptPendingReason::Retryable,
    }
}

fn valid_idempotency_key(value: &str) -> bool {
    (8..=200).contains(&value.len())
        && value.trim() == value
        && !value.chars().any(char::is_control)
}
