mod client;
mod config;
mod error;
mod model;
mod policy;

#[cfg(test)]
mod client_tests;

pub use client::AppUpdateRepository;
pub use config::RepositoryConfig;
pub use error::UpdateError;
pub use model::{
    Channel, ControlPolicy, InstalledRelease, Platform, Product, RepositoryIdentity,
    TrustedCandidate, UpdateUrgency,
};
pub use policy::rollback_allowed;
