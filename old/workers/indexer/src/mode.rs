#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IndexerMode {
    SearchEdge,
    EdgePolicy,
}

const EDGE_SUFFIX: &str = "-edge-policy-v1";

impl IndexerMode {
    pub fn parse(value: Option<String>) -> Result<Self, String> {
        match value.as_deref().unwrap_or("search-edge") {
            "search-edge" => Ok(Self::SearchEdge),
            "edge-policy" => Ok(Self::EdgePolicy),
            _ => Err("ASSETLIBRARY_INDEXER_MODE must be search-edge or edge-policy".to_owned()),
        }
    }

    pub fn projection(self) -> &'static str {
        match self {
            Self::SearchEdge => "search-edge-v1",
            Self::EdgePolicy => "edge-policy-v1",
        }
    }

    pub fn consumer(self, base: String) -> Result<String, String> {
        let base = super::safe_name("consumer base", base)?;
        // Reserve the suffix in both modes: a full worker must never compete on
        // the Edge-only durable and ACK an event without the other projection.
        if base.ends_with(EDGE_SUFFIX) {
            return Err("consumer base must not use the reserved edge-policy suffix".to_owned());
        }
        let name = match self {
            Self::SearchEdge => base,
            Self::EdgePolicy => format!("{base}{EDGE_SUFFIX}"),
        };
        super::safe_name("consumer name", name)
    }
}
