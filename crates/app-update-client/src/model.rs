use std::fmt;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Product {
    Loom,
    Hook,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
    Nightly,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum Platform {
    #[serde(rename = "windows-x86_64")]
    WindowsX86_64,
    #[serde(rename = "linux-x86_64")]
    LinuxX86_64,
    #[serde(rename = "macos-aarch64")]
    MacosAarch64,
    #[serde(rename = "macos-x86_64")]
    MacosX86_64,
}

macro_rules! display_as_json_name {
    ($type:ty) => {
        impl fmt::Display for $type {
            fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                let value = serde_json::to_value(self).map_err(|_| fmt::Error)?;
                formatter.write_str(value.as_str().ok_or(fmt::Error)?)
            }
        }
    };
}

display_as_json_name!(Product);
display_as_json_name!(Channel);
display_as_json_name!(Platform);

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RepositoryIdentity {
    pub product: Product,
    pub channel: Channel,
    pub platform: Platform,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledRelease {
    pub sequence: u64,
    pub sha256: String,
    pub policy_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ControlPolicy {
    pub(crate) schema_version: String,
    pub(crate) product: Product,
    pub(crate) channel: Channel,
    pub(crate) platform: Platform,
    pub(crate) policy_epoch: u64,
    pub(crate) installation_enabled: bool,
    pub(crate) minimum_release_sequence: u64,
    pub(crate) revoked_sha256: Vec<String>,
    pub(crate) reason: Option<String>,
}

impl ControlPolicy {
    pub(crate) fn from_slice(bytes: &[u8]) -> Result<Self, serde_json::Error> {
        serde_json::from_slice::<ControlPolicyDocument>(bytes).map(Into::into)
    }

    pub fn product(&self) -> Product {
        self.product
    }

    pub fn channel(&self) -> Channel {
        self.channel
    }

    pub fn platform(&self) -> Platform {
        self.platform
    }

    pub fn policy_epoch(&self) -> u64 {
        self.policy_epoch
    }

    pub fn installation_enabled(&self) -> bool {
        self.installation_enabled
    }

    pub fn minimum_release_sequence(&self) -> u64 {
        self.minimum_release_sequence
    }

    pub fn revoked_sha256(&self) -> &[String] {
        &self.revoked_sha256
    }

    pub fn reason(&self) -> Option<&str> {
        self.reason.as_deref()
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ControlPolicyDocument {
    schema_version: String,
    product: Product,
    channel: Channel,
    platform: Platform,
    policy_epoch: u64,
    installation_enabled: bool,
    minimum_release_sequence: u64,
    revoked_sha256: Vec<String>,
    reason: Option<String>,
}

impl From<ControlPolicyDocument> for ControlPolicy {
    fn from(document: ControlPolicyDocument) -> Self {
        Self {
            schema_version: document.schema_version,
            product: document.product,
            channel: document.channel,
            platform: document.platform,
            policy_epoch: document.policy_epoch,
            installation_enabled: document.installation_enabled,
            minimum_release_sequence: document.minimum_release_sequence,
            revoked_sha256: document.revoked_sha256,
            reason: document.reason,
        }
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct TargetDescriptor {
    pub schema_version: String,
    pub product: Product,
    pub channel: Channel,
    pub platform: Platform,
    pub version: String,
    pub release_sequence: u64,
    pub updater_protocol: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TrustedCandidate {
    pub(crate) target_path: String,
    pub(crate) version: semver::Version,
    pub(crate) release_sequence: u64,
    pub(crate) length: u64,
    pub(crate) sha256: String,
    pub(crate) urgency: UpdateUrgency,
}

impl TrustedCandidate {
    pub fn target_path(&self) -> &str {
        &self.target_path
    }

    pub fn version(&self) -> &semver::Version {
        &self.version
    }

    pub fn release_sequence(&self) -> u64 {
        self.release_sequence
    }

    pub fn length(&self) -> u64 {
        self.length
    }

    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    pub fn urgency(&self) -> UpdateUrgency {
        self.urgency
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UpdateUrgency {
    Optional,
    Required,
}
