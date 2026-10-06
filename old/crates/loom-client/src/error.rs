#[derive(Debug, thiserror::Error)]
pub enum ClientError {
    #[error("client configuration is invalid: {0}")]
    Configuration(&'static str),
    #[error("request input is invalid: {0}")]
    InvalidInput(&'static str),
    #[error("server response violates the AssetLibrary contract")]
    InvalidResponse,
    #[error("download URL origin is not allowed")]
    DownloadOriginDenied,
    #[error("download session has expired and must be renewed")]
    DownloadSessionExpired,
    #[error("AssetLibrary request failed with HTTP {0}")]
    HttpStatus(u16),
    #[error("AssetLibrary transport failed")]
    Transport(#[from] reqwest::Error),
    #[error("local package I/O failed")]
    Io(#[from] std::io::Error),
    #[error("download was cancelled")]
    Cancelled,
    #[error("download made no progress before the stall timeout")]
    DownloadStalled,
    #[error("download response ended before the declared range was complete")]
    IncompleteDownload,
    #[error("download response range is invalid")]
    InvalidRange,
    #[error("downloaded archive size does not match the challenge")]
    SizeMismatch,
    #[error("downloaded archive SHA-256 does not match the challenge")]
    ArchiveDigestMismatch,
    #[error("canonical package SHA-256 does not match the challenge")]
    CanonicalDigestMismatch,
    #[error("publisher signing key does not match its fingerprint")]
    SigningKeyMismatch,
    #[error("package manifest is incompatible with this Loom host")]
    HostIncompatible,
    #[error("package manifest validation failed")]
    Manifest(#[from] assetlibrary_supply_chain::ManifestError),
    #[error("package signature validation failed")]
    Signature(#[from] assetlibrary_supply_chain::SignatureError),
    #[error("package archive validation failed")]
    Archive(#[from] assetlibrary_supply_chain::ArchiveError),
    #[error("package verification task failed")]
    VerificationTask,
    #[error("offline install receipt queue is full")]
    ReceiptQueueFull,
    #[error("offline install receipt queue contains invalid state")]
    ReceiptQueueCorrupt,
    #[error("Loom rejected the verified package: {0}")]
    Install(String),
    #[error("Loom could not restore the previous installation after a failed activation")]
    RollbackFailed,
}

impl ClientError {
    pub fn is_retryable(&self) -> bool {
        matches!(
            self,
            Self::Transport(_)
                | Self::DownloadSessionExpired
                | Self::DownloadStalled
                | Self::IncompleteDownload
                | Self::HttpStatus(408 | 429 | 500..=599)
        )
    }
}
