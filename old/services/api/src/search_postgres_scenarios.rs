use super::*;

pub(super) async fn eligibility_and_revocation(pool: &PgPool, search: &PostgresSearchRepository) {
    for (mutate, restore) in [
        (
            "UPDATE packages SET visibility='private'",
            "UPDATE packages SET visibility='public'",
        ),
        (
            "UPDATE packages SET visibility='unlisted'",
            "UPDATE packages SET visibility='public'",
        ),
        (
            "UPDATE packages SET status='draft'",
            "UPDATE packages SET status='published'",
        ),
        (
            "UPDATE packages SET status='archived'",
            "UPDATE packages SET status='published'",
        ),
        (
            "UPDATE publishers SET status='suspended'",
            "UPDATE publishers SET status='active'",
        ),
        (
            "UPDATE releases SET status='yanked'",
            "UPDATE releases SET status='published'",
        ),
        (
            "UPDATE artifacts SET status='quarantined'",
            "UPDATE artifacts SET status='verified'",
        ),
        (
            "UPDATE artifacts SET canonical_sha256=NULL",
            "UPDATE artifacts SET canonical_sha256=decode(repeat('aa',32),'hex')",
        ),
        (
            "UPDATE artifacts SET size_bytes=NULL",
            "UPDATE artifacts SET size_bytes=1",
        ),
        (
            "UPDATE artifacts SET media_type=NULL",
            "UPDATE artifacts SET media_type='application/zip'",
        ),
        (
            "UPDATE artifacts SET published_object_key='quarantine/untrusted'",
            "UPDATE artifacts SET published_object_key='sha256/aa/'||repeat('aa',32)",
        ),
        (
            "UPDATE publisher_signing_keys SET status='revoked'",
            "UPDATE publisher_signing_keys SET status='active'",
        ),
        (
            "UPDATE artifacts SET signature='{}'",
            "UPDATE artifacts SET signature='{\"keyId\":\"fixture-key\"}'",
        ),
        (
            "DELETE FROM published_release_artifacts",
            "INSERT INTO published_release_artifacts SELECT release_id,id FROM artifacts",
        ),
    ] {
        execute(pool, mutate).await;
        assert!(
            search.search(&filter()).await.unwrap().items.is_empty(),
            "{mutate}"
        );
        execute(pool, restore).await;
        assert_eq!(
            search.search(&filter()).await.unwrap().items.len(),
            8,
            "{restore}"
        );
    }
    for (target, source) in [
        ("publisher", "SELECT id::text FROM publishers"),
        ("package", "SELECT id::text FROM packages"),
        ("release", "SELECT id::text FROM releases"),
        ("artifact", "SELECT id::text FROM artifacts"),
        (
            "signing_key",
            "SELECT publisher_id::text||':'||key_id FROM publisher_signing_keys",
        ),
    ] {
        execute(pool, &format!("INSERT INTO blocklist_entries SELECT '{target}', value, 'active' FROM ({source}) refs(value)")).await;
        assert!(
            search.search(&filter()).await.unwrap().items.is_empty(),
            "{target}"
        );
        execute(pool, "UPDATE blocklist_entries SET status='inactive'").await;
        assert_eq!(search.search(&filter()).await.unwrap().items.len(), 8);
        execute(pool, "DELETE FROM blocklist_entries").await;
    }
    // A cursor must not resurrect a newly revoked second page.
    let mut query = filter();
    query.limit = 1;
    query.cursor = search.search(&query).await.unwrap().next_cursor;
    execute(pool, "INSERT INTO blocklist_entries SELECT 'package', id::text, 'active' FROM packages WHERE slug='package-2'").await;
    assert_eq!(
        search.search(&query).await.unwrap().items[0].slug,
        "package-3"
    );
    execute(pool, "DELETE FROM blocklist_entries").await;
}

pub(super) async fn deadline_and_recovery(pool: &PgPool, search: &PostgresSearchRepository) {
    let original: String = sqlx::query_scalar("SHOW statement_timeout")
        .fetch_one(pool)
        .await
        .unwrap();
    execute(pool, "ALTER TABLE packages RENAME TO slow_packages; CREATE TEMP VIEW packages AS SELECT * FROM slow_packages WHERE pg_sleep(10) IS NULL").await;
    let started = Instant::now();
    assert!(matches!(
        search.search(&filter()).await,
        Err(SearchError::Unavailable)
    ));
    assert!(started.elapsed() < Duration::from_secs(3));
    let after: String = sqlx::query_scalar("SHOW statement_timeout")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(
        after, original,
        "LOCAL timeout must not leak into pooled sessions"
    );
    // The conservative lifecycle guard closes failed/cancelled connections.
    // Its temporary fixture tables disappear; rebuild on the fresh session.
    execute(pool, include_str!("search_postgres_fixture.sql")).await;
    assert_eq!(search.search(&filter()).await.unwrap().items.len(), 8);
}
