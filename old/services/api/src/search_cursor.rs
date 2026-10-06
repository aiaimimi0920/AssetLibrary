//! Provider-specific opaque cursor. It is a query position, never an authorization token.
use crate::search::{SearchError, SearchFilter};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use time::{OffsetDateTime, format_description::well_known::Rfc3339};
use uuid::Uuid;

const POSTGRES_VERSION: &str = "postgres-v1";

pub(crate) struct PostgresCursor {
    pub updated_at: OffsetDateTime,
    pub package_id: Uuid,
}

fn fingerprint(filter: &SearchFilter) -> Result<String, SearchError> {
    let scope = serde_json::to_vec(&(&filter.query, &filter.kind, &filter.tag))
        .map_err(|_| SearchError::InvalidProjection)?;
    Ok(hex::encode(Sha256::digest(scope)))
}

fn parts(value: &[Value]) -> Option<(PostgresCursor, &str)> {
    if value.len() != 4 || value[0].as_str()? != POSTGRES_VERSION {
        return None;
    }
    let timestamp = value[1].as_str()?;
    if timestamp.len() > 40 {
        return None;
    }
    let updated_at = OffsetDateTime::parse(timestamp, &Rfc3339).ok()?;
    if !(1970..=9999).contains(&updated_at.year()) {
        return None;
    }
    let id = value[2].as_str()?;
    let package_id = Uuid::parse_str(id).ok()?;
    if package_id.is_nil() || package_id.to_string() != id {
        return None;
    }
    let scope = value[3].as_str()?;
    if scope.len() != 64
        || !scope
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    Some((
        PostgresCursor {
            updated_at,
            package_id,
        },
        scope,
    ))
}

pub(crate) fn valid_postgres_shape(value: &[Value]) -> bool {
    parts(value).is_some()
}

pub(crate) fn decode(filter: &SearchFilter) -> Result<Option<PostgresCursor>, SearchError> {
    filter
        .cursor
        .as_ref()
        .map(|value| {
            let (cursor, scope) = parts(value).ok_or(SearchError::InvalidCursor)?;
            if scope != fingerprint(filter)? {
                return Err(SearchError::InvalidCursor);
            }
            Ok(cursor)
        })
        .transpose()
}

pub(crate) fn encode(
    filter: &SearchFilter,
    updated_at: OffsetDateTime,
    package_id: Uuid,
) -> Result<Vec<Value>, SearchError> {
    let timestamp = updated_at
        .format(&Rfc3339)
        .map_err(|_| SearchError::InvalidProjection)?;
    Ok(vec![
        json!(POSTGRES_VERSION),
        json!(timestamp),
        json!(package_id),
        json!(fingerprint(filter)?),
    ])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn filter() -> SearchFilter {
        SearchFilter {
            query: Some("中文%_".into()),
            kind: None,
            tag: None,
            cursor: None,
            limit: 1,
        }
    }

    #[test]
    fn postgres_cursor_binds_provider_version_and_query_but_not_page_size() {
        let mut filter = filter();
        let timestamp = OffsetDateTime::parse("2026-10-02T06:00:00.123456Z", &Rfc3339).unwrap();
        let id = Uuid::from_u128(42);
        filter.cursor = Some(encode(&filter, timestamp, id).unwrap());
        filter.limit = 100;
        let cursor = decode(&filter).unwrap().unwrap();
        assert_eq!(cursor.updated_at, timestamp);
        assert_eq!(cursor.package_id, id);
        for dimension in 0..3 {
            let mut changed = filter.clone();
            match dimension {
                0 => changed.query = Some("other".into()),
                1 => changed.tag = Some("other".into()),
                _ => changed.kind = Some(assetlibrary_contracts::PackageKind::Art),
            }
            assert!(matches!(decode(&changed), Err(SearchError::InvalidCursor)));
        }
        for invalid in [
            vec![json!(1.0), json!(1_788_000_000_000_i64), json!(id)],
            vec![
                json!("postgres-v2"),
                json!("2026-10-02T06:00:00Z"),
                json!(id),
                json!("a".repeat(64)),
            ],
        ] {
            filter.cursor = Some(invalid);
            assert!(matches!(decode(&filter), Err(SearchError::InvalidCursor)));
        }
    }

    #[test]
    fn postgres_cursor_rejects_malformed_fields() {
        let filter = filter();
        let valid = encode(&filter, OffsetDateTime::UNIX_EPOCH, Uuid::from_u128(42)).unwrap();
        assert!(valid_postgres_shape(&valid));
        for (index, invalid) in [
            (1, json!("not-a-date")),
            (1, json!("1969-12-31T00:00:00Z")),
            (2, json!(Uuid::nil())),
            (3, json!("x".repeat(64))),
            (3, json!("a".repeat(63))),
        ] {
            let mut value = valid.clone();
            value[index] = invalid;
            assert!(!valid_postgres_shape(&value));
        }
    }
}
