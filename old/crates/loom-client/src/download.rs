use assetlibrary_contracts::{InstallChallenge, InstallHostProfile};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use time::OffsetDateTime;
use tokio::{fs, io::AsyncWriteExt};
use tokio_util::sync::CancellationToken;

use crate::{
    ClientError, LoomApiClient, LoomDownloadSession, VerifiedPackage,
    cache::{CachePaths, file_size, finalize_verified, link_verified, open_partial_append},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DownloadProgress {
    pub downloaded_bytes: u64,
    pub total_bytes: u64,
}

pub type ProgressObserver = Arc<dyn Fn(DownloadProgress) + Send + Sync>;

#[derive(Clone)]
pub struct ResumableDownloader {
    api: LoomApiClient,
    cache_root: PathBuf,
}

impl ResumableDownloader {
    pub fn new(api: LoomApiClient, cache_root: impl Into<PathBuf>) -> Self {
        Self {
            api,
            cache_root: cache_root.into(),
        }
    }

    pub async fn download_and_verify(
        &self,
        session: &LoomDownloadSession,
        challenge: &InstallChallenge,
        host: &InstallHostProfile,
        cancellation: &CancellationToken,
        observer: Option<&ProgressObserver>,
    ) -> Result<VerifiedPackage, ClientError> {
        validate_binding(session, challenge, host)?;
        self.api.validate_download_url(&session.download_url)?;
        let paths = CachePaths::prepare(&self.cache_root, challenge).await?;
        if fs::try_exists(&paths.verified).await? {
            return verify_blocking(paths.verified, challenge.clone(), host.clone()).await;
        }
        paths.ensure_state(challenge).await?;
        self.transfer(session, challenge, &paths.partial, cancellation, observer)
            .await?;
        verify_blocking(paths.partial.clone(), challenge.clone(), host.clone()).await?;
        link_verified(&paths.partial, &paths.verified).await?;
        let package =
            verify_blocking(paths.verified.clone(), challenge.clone(), host.clone()).await?;
        finalize_verified(&paths.partial, &paths.verified).await?;
        let _ = fs::remove_file(paths.state).await;
        Ok(package)
    }

    async fn transfer(
        &self,
        session: &LoomDownloadSession,
        challenge: &InstallChallenge,
        partial_path: &Path,
        cancellation: &CancellationToken,
        observer: Option<&ProgressObserver>,
    ) -> Result<(), ClientError> {
        let total = challenge.artifact.size_bytes;
        let mut attempts = 0u8;
        loop {
            let offset = file_size(partial_path).await?;
            if offset > total {
                return Err(ClientError::SizeMismatch);
            }
            report(observer, offset, total);
            if offset == total {
                return Ok(());
            }
            if OffsetDateTime::now_utc() >= session.expires_at {
                return Err(ClientError::DownloadSessionExpired);
            }
            match self
                .transfer_once(session, partial_path, offset, total, cancellation, observer)
                .await
            {
                Ok(()) => {}
                Err(error) if error.is_retryable() && attempts < self.api.config.retry_limit => {
                    attempts += 1;
                    let delay = Duration::from_millis(200 * (1u64 << attempts.min(4)));
                    tokio::select! {
                        _ = cancellation.cancelled() => return Err(ClientError::Cancelled),
                        _ = tokio::time::sleep(delay) => {}
                    }
                }
                Err(error) => return Err(error),
            }
        }
    }

    async fn transfer_once(
        &self,
        session: &LoomDownloadSession,
        path: &Path,
        offset: u64,
        total: u64,
        cancellation: &CancellationToken,
        observer: Option<&ProgressObserver>,
    ) -> Result<(), ClientError> {
        let request = self
            .api
            .http
            .get(session.download_url.clone())
            .header(reqwest::header::AUTHORIZATION, session.authorization())
            .header(reqwest::header::ACCEPT_ENCODING, "identity")
            .header(reqwest::header::RANGE, format!("bytes={offset}-"));
        let mut response = tokio::select! {
            _ = cancellation.cancelled() => return Err(ClientError::Cancelled),
            result = tokio::time::timeout(self.api.config.stall_timeout, request.send()) => {
                result.map_err(|_| ClientError::DownloadStalled)??
            }
        };
        let expected_end = validate_range_response(&response, offset, total)?;
        let mut output = open_partial_append(path).await?;
        let mut written = offset;
        loop {
            let chunk = tokio::select! {
                _ = cancellation.cancelled() => return Err(ClientError::Cancelled),
                result = tokio::time::timeout(self.api.config.stall_timeout, response.chunk()) => {
                    result.map_err(|_| ClientError::DownloadStalled)??
                }
            };
            let Some(chunk) = chunk else { break };
            written = written
                .checked_add(chunk.len() as u64)
                .filter(|value| *value <= expected_end)
                .ok_or(ClientError::SizeMismatch)?;
            output.write_all(&chunk).await?;
            report(observer, written, total);
        }
        output.sync_all().await?;
        if written != expected_end {
            return Err(ClientError::IncompleteDownload);
        }
        Ok(())
    }
}

fn validate_binding(
    session: &LoomDownloadSession,
    challenge: &InstallChallenge,
    host: &InstallHostProfile,
) -> Result<(), ClientError> {
    if !challenge.validate()
        || !host.validate()
        || session.artifact != challenge.artifact
        || challenge.artifact.size_bytes > assetlibrary_supply_chain::MAX_ARCHIVE_BYTES
    {
        return Err(ClientError::InvalidResponse);
    }
    Ok(())
}

fn validate_range_response(
    response: &reqwest::Response,
    offset: u64,
    total: u64,
) -> Result<u64, ClientError> {
    let status = response.status();
    if status != reqwest::StatusCode::PARTIAL_CONTENT
        && !(offset == 0 && status == reqwest::StatusCode::OK)
    {
        return Err(ClientError::HttpStatus(status.as_u16()));
    }
    if status == reqwest::StatusCode::OK {
        if response.content_length() != Some(total) {
            return Err(ClientError::InvalidRange);
        }
        return Ok(total);
    }
    let value = response
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("bytes "))
        .ok_or(ClientError::InvalidRange)?;
    let (range, declared_total) = value.split_once('/').ok_or(ClientError::InvalidRange)?;
    let (start, end) = range.split_once('-').ok_or(ClientError::InvalidRange)?;
    let start = start
        .parse::<u64>()
        .map_err(|_| ClientError::InvalidRange)?;
    let end = end.parse::<u64>().map_err(|_| ClientError::InvalidRange)?;
    let declared_total = declared_total
        .parse::<u64>()
        .map_err(|_| ClientError::InvalidRange)?;
    let length = end
        .checked_sub(start)
        .and_then(|value| value.checked_add(1))
        .ok_or(ClientError::InvalidRange)?;
    if start != offset
        || end >= total
        || declared_total != total
        || response.content_length() != Some(length)
    {
        return Err(ClientError::InvalidRange);
    }
    end.checked_add(1).ok_or(ClientError::InvalidRange)
}

async fn verify_blocking(
    path: PathBuf,
    challenge: InstallChallenge,
    host: InstallHostProfile,
) -> Result<VerifiedPackage, ClientError> {
    tokio::task::spawn_blocking(move || crate::verify::verify_package(path, challenge, &host))
        .await
        .map_err(|_| ClientError::VerificationTask)?
}

fn report(observer: Option<&ProgressObserver>, downloaded: u64, total: u64) {
    if let Some(observer) = observer {
        observer(DownloadProgress {
            downloaded_bytes: downloaded,
            total_bytes: total,
        });
    }
}
