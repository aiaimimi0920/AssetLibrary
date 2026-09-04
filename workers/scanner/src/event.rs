pub use assetlibrary_contracts::VerificationRequested;

#[cfg(test)]
mod tests {
    use super::VerificationRequested;

    #[test]
    fn event_digest_is_strictly_lowercase_sha256() {
        let input = format!(
            r#"{{"event_id":"018f47d2-4a75-7fa1-a12b-9a1f19d46ea4","occurred_at":"2026-09-03T08:00:00Z","schema_version":"1.0","actor":{{"type":"system","id":"test"}},"package_id":"018f47d2-4a75-7fa1-a12b-9a1f19d46ea2","release_id":"018f47d2-4a75-7fa1-a12b-9a1f19d46ea3","artifact_id":"018f47d2-4a75-7fa1-a12b-9a1f19d46ea5","object_key":"quarantine/a","digest":"sha256:{}"}}"#,
            "a".repeat(64)
        );
        let mut event: VerificationRequested = serde_json::from_str(&input).unwrap();
        assert!(event.validate());
        event.digest = format!("sha256:{}", "A".repeat(64));
        assert!(!event.validate());
    }
}
