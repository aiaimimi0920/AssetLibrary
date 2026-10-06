#[derive(Debug, thiserror::Error)]
pub enum UpdateError {
    #[error("application update configuration is invalid: {0}")]
    Configuration(&'static str),
    #[error("trusted update metadata violates the Neuro policy: {0}")]
    Policy(&'static str),
    #[error("the requested update target is not present in trusted metadata")]
    TargetNotFound,
    #[error("the application update repository is unavailable or untrusted")]
    Repository(#[from] tough::error::Error),
    #[error("application update state I/O failed")]
    Io(#[from] std::io::Error),
    #[error("trusted application update JSON is invalid")]
    Json(#[from] serde_json::Error),
}
