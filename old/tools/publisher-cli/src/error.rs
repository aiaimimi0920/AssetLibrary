#[derive(Debug, thiserror::Error)]
pub enum CliError {
    #[error("configuration is invalid: {0}")]
    Configuration(&'static str),
    #[error("input validation failed: {0}")]
    Validation(String),
    #[error("publisher authentication failed")]
    Authentication,
    #[error("AssetLibrary request conflicted with current state")]
    Conflict,
    #[error("AssetLibrary request failed with HTTP {0}")]
    Server(u16),
    #[error("network operation failed")]
    Network(#[from] reqwest::Error),
    #[error("filesystem operation failed")]
    Io(#[from] std::io::Error),
    #[error("package manifest validation failed")]
    Manifest(#[from] assetlibrary_supply_chain::ManifestError),
    #[error("package signature validation failed")]
    Signature(#[from] assetlibrary_supply_chain::SignatureError),
    #[error("package archive validation failed")]
    Archive(#[from] assetlibrary_supply_chain::ArchiveError),
    #[error("package signing key is invalid")]
    SigningKey,
    #[error("multipart upload did not complete")]
    PartialUpload,
}

impl CliError {
    pub fn exit_code(&self) -> u8 {
        match self {
            Self::Configuration(_) => 2,
            Self::Validation(_) | Self::Manifest(_) | Self::Signature(_) | Self::Archive(_) => 4,
            Self::Authentication => 3,
            Self::Network(_) => 5,
            Self::Conflict => 6,
            Self::PartialUpload => 7,
            Self::Io(_) | Self::SigningKey | Self::Server(_) => 1,
        }
    }

    pub fn from_status(status: reqwest::StatusCode) -> Self {
        match status.as_u16() {
            401 | 403 => Self::Authentication,
            409 => Self::Conflict,
            value => Self::Server(value),
        }
    }
}
