use std::{io, path::Path, path::PathBuf, sync::Arc};
use tempfile::TempDir;
use tokio::{sync::OwnedSemaphorePermit, sync::Semaphore, task::JoinError};

pub struct InspectionExecutor {
    slot: Arc<Semaphore>,
}

pub struct InspectionWorkspace {
    // Remove the files before admitting another job, including on panic.
    directory: TempDir,
    _permit: OwnedSemaphorePermit,
}

impl InspectionExecutor {
    pub fn new() -> Self {
        Self {
            slot: Arc::new(Semaphore::new(1)),
        }
    }

    pub async fn reserve(&self, temporary_root: &Path) -> Result<InspectionWorkspace, io::Error> {
        let permit = self
            .slot
            .clone()
            .acquire_owned()
            .await
            .expect("the private inspection semaphore is never closed");
        let directory = tempfile::Builder::new()
            .prefix("assetlibrary-scan-")
            .tempdir_in(temporary_root)?;
        Ok(InspectionWorkspace {
            directory,
            _permit: permit,
        })
    }

    pub async fn wait_until_idle(&self) {
        let _permit = self
            .slot
            .acquire()
            .await
            .expect("the private inspection semaphore is never closed");
    }
}

impl InspectionWorkspace {
    pub fn archive_path(&self) -> PathBuf {
        self.directory.path().join("artifact.zip")
    }

    pub async fn inspect<T, F>(self, inspect: F) -> Result<(Self, T), JoinError>
    where
        T: Send + 'static,
        F: FnOnce(&Path) -> T + Send + 'static,
    {
        // Dropping a spawn_blocking JoinHandle does not stop its thread. Move
        // both the files and the slot into that thread, not the awaiting future.
        tokio::task::spawn_blocking(move || {
            let result = inspect(&self.archive_path());
            (self, result)
        })
        .await
    }
}

#[cfg(test)]
#[path = "inspection_executor_tests.rs"]
mod tests;
