use crate::SCHEMA_VERSION_V1;
use serde::{Deserialize, Serialize};
use std::collections::BTreeSet;

pub const SITEMAP_SHARD_COUNT: usize = 256;
pub const SITEMAP_MAX_SLUGS: usize = 5000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SitemapManifest {
    pub schema_version: String,
    pub shards: Vec<String>,
}

impl SitemapManifest {
    pub fn validate(&self) -> bool {
        self.schema_version == SCHEMA_VERSION_V1
            && self.shards.len() <= SITEMAP_SHARD_COUNT
            && self.shards.iter().all(|value| valid_sitemap_shard(value))
            && self.shards.windows(2).all(|pair| pair[0] < pair[1])
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SitemapShard {
    pub schema_version: String,
    pub shard: String,
    pub slugs: Vec<String>,
}

impl SitemapShard {
    pub fn validate(&self) -> bool {
        let mut seen = BTreeSet::new();
        self.schema_version == SCHEMA_VERSION_V1
            && valid_sitemap_shard(&self.shard)
            && self.slugs.len() <= SITEMAP_MAX_SLUGS
            && self.slugs.iter().all(|slug| {
                !slug.is_empty()
                    && slug.len() <= 120
                    && slug.bytes().enumerate().all(|(index, byte)| {
                        byte.is_ascii_lowercase()
                            || byte.is_ascii_digit()
                            || (index > 0 && byte == b'-')
                    })
                    && seen.insert(slug)
            })
    }
}

pub fn valid_sitemap_shard(value: &str) -> bool {
    value.len() == 2
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn sitemap_manifest_is_bounded_ordered_unique_and_versioned() {
        let mut value = SitemapManifest {
            schema_version: SCHEMA_VERSION_V1.to_owned(),
            shards: (0..=255).map(|shard| format!("{shard:02x}")).collect(),
        };
        assert!(value.validate());
        value.shards.push("ff".to_owned());
        assert!(!value.validate());
        value.shards = vec!["00".into(), "00".into()];
        assert!(!value.validate());
        value.shards = vec!["ff".into(), "00".into()];
        assert!(!value.validate());
        value.shards.clear();
        assert!(value.validate());
        value.schema_version = "2.0".into();
        assert!(!value.validate());
    }

    #[test]
    fn sitemap_shard_requires_canonical_ids_and_only_bounded_unique_slugs() {
        let mut value = SitemapShard {
            schema_version: SCHEMA_VERSION_V1.to_owned(),
            shard: "ff".into(),
            slugs: (0..SITEMAP_MAX_SLUGS)
                .map(|i| format!("package-{i}"))
                .collect(),
        };
        assert!(value.validate());
        value.slugs.push("overflow".into());
        assert!(!value.validate());
        value.slugs = vec!["repeated".into(), "repeated".into()];
        assert!(!value.validate());
        for slug in ["", "-bad", "Uppercase", "a/b", "a&b", "a\n", "中文"] {
            value.slugs = vec![slug.into()];
            assert!(!value.validate(), "{slug}");
        }
        value.slugs = vec!["a".repeat(121)];
        assert!(!value.validate());
        value.slugs.clear();
        assert!(value.validate());
        for shard in ["", "0", "000", "FF", "-1", "gg", "é"] {
            value.shard = shard.into();
            assert!(!value.validate(), "{shard}");
        }
    }

    #[test]
    fn sitemap_contracts_reject_unrequested_identifiers_and_private_fields() {
        let manifest = json!({"schema_version":"1.0", "shards":[], "next_cursor":"secret"});
        assert!(serde_json::from_value::<SitemapManifest>(manifest).is_err());
        for field in [
            "package_id",
            "object_key",
            "principal",
            "signature",
            "next_cursor",
        ] {
            let mut leaf = json!({"schema_version":"1.0", "shard":"00", "slugs":[]});
            leaf[field] = json!("secret");
            assert!(serde_json::from_value::<SitemapShard>(leaf).is_err());
        }
    }
}
