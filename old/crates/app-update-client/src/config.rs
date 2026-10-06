use std::path::PathBuf;

use url::Url;

use crate::{RepositoryIdentity, UpdateError};

const MAX_BOOTSTRAP_ROOT_BYTES: usize = 256 * 1024;

#[derive(Clone, Debug)]
pub struct RepositoryConfig {
    pub(crate) identity: RepositoryIdentity,
    pub(crate) bootstrap_root: Vec<u8>,
    pub(crate) metadata_base_url: Url,
    pub(crate) targets_base_url: Url,
    pub(crate) datastore: PathBuf,
}

impl RepositoryConfig {
    pub fn new(
        identity: RepositoryIdentity,
        bootstrap_root: Vec<u8>,
        metadata_base_url: &str,
        targets_base_url: &str,
        datastore: PathBuf,
    ) -> Result<Self, UpdateError> {
        if bootstrap_root.is_empty() || bootstrap_root.len() > MAX_BOOTSTRAP_ROOT_BYTES {
            return Err(UpdateError::Configuration("bootstrap root size is invalid"));
        }
        let metadata_base_url = trusted_base_url(metadata_base_url)?;
        let targets_base_url = trusted_base_url(targets_base_url)?;
        if datastore.as_os_str().is_empty() {
            return Err(UpdateError::Configuration("datastore path is empty"));
        }
        Ok(Self {
            identity,
            bootstrap_root,
            metadata_base_url,
            targets_base_url,
            datastore,
        })
    }

    #[cfg(test)]
    pub(crate) fn for_test(
        identity: RepositoryIdentity,
        bootstrap_root: Vec<u8>,
        metadata_base_url: Url,
        targets_base_url: Url,
        datastore: PathBuf,
    ) -> Self {
        Self {
            identity,
            bootstrap_root,
            metadata_base_url,
            targets_base_url,
            datastore,
        }
    }
}

fn trusted_base_url(value: &str) -> Result<Url, UpdateError> {
    let mut url =
        Url::parse(value).map_err(|_| UpdateError::Configuration("repository URL is invalid"))?;
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(UpdateError::Configuration("repository URL is unsafe"));
    }
    if !url.path().ends_with('/') {
        let path = format!("{}/", url.path());
        url.set_path(&path);
    }
    Ok(url)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{Channel, Platform, Product};

    fn identity() -> RepositoryIdentity {
        RepositoryIdentity {
            product: Product::Loom,
            channel: Channel::Stable,
            platform: Platform::WindowsX86_64,
        }
    }

    #[test]
    fn accepts_https_repository_paths() {
        let config = RepositoryConfig::new(
            identity(),
            vec![1],
            "https://updates.example/loom/stable/metadata",
            "https://download.example/loom/stable/targets/",
            PathBuf::from("state"),
        )
        .unwrap();
        assert!(config.metadata_base_url.path().ends_with('/'));
    }

    #[test]
    fn rejects_credentials_query_and_insecure_transport() {
        for value in [
            "http://updates.example/metadata/",
            "https://user@updates.example/metadata/",
            "https://updates.example/metadata/?token=x",
        ] {
            assert!(
                RepositoryConfig::new(
                    identity(),
                    vec![1],
                    value,
                    "https://download.example/targets/",
                    PathBuf::from("state"),
                )
                .is_err()
            );
        }
    }
}
