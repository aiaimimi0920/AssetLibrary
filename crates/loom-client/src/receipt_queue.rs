use assetlibrary_contracts::InstallReceipt;
use std::{
    path::{Path, PathBuf},
    sync::Arc,
};
use tokio::{fs, io::AsyncWriteExt, sync::Mutex};
use uuid::Uuid;

use crate::{AccountBearer, ClientError, LoomApiClient, QueuedReceipt};

const MAX_PENDING_RECEIPTS: usize = 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PendingReceiptSync {
    pub receipt_id: Uuid,
    pub retryable: bool,
    pub http_status: Option<u16>,
}

#[derive(Debug, Default)]
pub struct ReceiptQueueReport {
    pub synced: Vec<InstallReceipt>,
    pub pending: Vec<PendingReceiptSync>,
}

#[derive(Clone)]
pub struct ReceiptQueue {
    root: PathBuf,
    operation: Arc<Mutex<()>>,
}

impl ReceiptQueue {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            operation: Arc::new(Mutex::new(())),
        }
    }

    pub async fn enqueue(&self, receipt: &QueuedReceipt) -> Result<(), ClientError> {
        if !receipt.validate() {
            return Err(ClientError::InvalidInput("invalid queued receipt"));
        }
        let _guard = self.operation.lock().await;
        self.prepare().await?;
        let current = self.load_unlocked().await?;
        if current.len() >= MAX_PENDING_RECEIPTS
            && !current
                .iter()
                .any(|value| value.receipt_id == receipt.receipt_id)
        {
            return Err(ClientError::ReceiptQueueFull);
        }
        let destination = self.path(receipt.receipt_id);
        let expected = serde_json::to_vec(receipt).map_err(|_| ClientError::ReceiptQueueCorrupt)?;
        if fs::try_exists(&destination).await? {
            return same_file(&destination, &expected).await;
        }
        let temporary = self
            .root
            .join(format!(".{}.{}.tmp", receipt.receipt_id, Uuid::new_v4()));
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .await?;
        file.write_all(&expected).await?;
        file.sync_all().await?;
        let link_result = match fs::hard_link(&temporary, &destination).await {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                same_file(&destination, &expected).await
            }
            Err(error) => Err(error.into()),
        };
        let cleanup_result = fs::remove_file(&temporary).await;
        link_result?;
        cleanup_result?;
        Ok(())
    }

    pub async fn pending(&self) -> Result<Vec<QueuedReceipt>, ClientError> {
        let _guard = self.operation.lock().await;
        self.prepare().await?;
        self.load_unlocked().await
    }

    pub async fn flush(
        &self,
        api: &LoomApiClient,
        account: &AccountBearer,
    ) -> Result<ReceiptQueueReport, ClientError> {
        let _guard = self.operation.lock().await;
        self.prepare().await?;
        let receipts = self.load_unlocked().await?;
        let mut report = ReceiptQueueReport::default();
        for receipt in receipts {
            match receipt.submit(api, account).await {
                Ok(verified) => {
                    fs::remove_file(self.path(receipt.receipt_id)).await?;
                    report.synced.push(verified);
                }
                Err(error) => report.pending.push(PendingReceiptSync {
                    receipt_id: receipt.receipt_id,
                    retryable: error.is_retryable()
                        || matches!(&error, ClientError::HttpStatus(401)),
                    http_status: match &error {
                        ClientError::HttpStatus(status) => Some(*status),
                        _ => None,
                    },
                }),
            }
        }
        Ok(report)
    }

    async fn prepare(&self) -> Result<(), ClientError> {
        reject_symlink(&self.root).await?;
        fs::create_dir_all(&self.root).await?;
        reject_symlink(&self.root).await?;
        harden_directory(&self.root).await
    }

    async fn load_unlocked(&self) -> Result<Vec<QueuedReceipt>, ClientError> {
        let mut directory = fs::read_dir(&self.root).await?;
        let mut paths = Vec::new();
        while let Some(entry) = directory.next_entry().await? {
            let path = entry.path();
            let Some(name) = path.file_name().and_then(|value| value.to_str()) else {
                return Err(ClientError::ReceiptQueueCorrupt);
            };
            if name.starts_with('.') && name.ends_with(".tmp") {
                continue;
            }
            if path.extension().and_then(|value| value.to_str()) != Some("json")
                || entry.file_type().await?.is_symlink()
            {
                return Err(ClientError::ReceiptQueueCorrupt);
            }
            paths.push(path);
            if paths.len() > MAX_PENDING_RECEIPTS {
                return Err(ClientError::ReceiptQueueFull);
            }
        }
        paths.sort();
        let mut receipts = Vec::with_capacity(paths.len());
        for path in paths {
            let receipt = serde_json::from_slice::<QueuedReceipt>(&fs::read(&path).await?)
                .map_err(|_| ClientError::ReceiptQueueCorrupt)?;
            let path_id = path
                .file_stem()
                .and_then(|value| value.to_str())
                .and_then(|value| Uuid::parse_str(value).ok());
            if !receipt.validate() || path_id != Some(receipt.receipt_id) {
                return Err(ClientError::ReceiptQueueCorrupt);
            }
            receipts.push(receipt);
        }
        Ok(receipts)
    }

    fn path(&self, receipt_id: Uuid) -> PathBuf {
        self.root.join(format!("{receipt_id}.json"))
    }
}

async fn same_file(path: &Path, expected: &[u8]) -> Result<(), ClientError> {
    if fs::read(path).await? == expected {
        Ok(())
    } else {
        Err(ClientError::ReceiptQueueCorrupt)
    }
}

async fn reject_symlink(path: &Path) -> Result<(), ClientError> {
    match fs::symlink_metadata(path).await {
        Ok(metadata) if metadata.file_type().is_symlink() => {
            Err(ClientError::Configuration("receipt queue is a symlink"))
        }
        Ok(_) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.into()),
    }
}

#[cfg(unix)]
async fn harden_directory(path: &Path) -> Result<(), ClientError> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, std::fs::Permissions::from_mode(0o700)).await?;
    Ok(())
}

#[cfg(not(unix))]
async fn harden_directory(_path: &Path) -> Result<(), ClientError> {
    Ok(())
}
