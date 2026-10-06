use super::*;

pub(super) async fn current_eligibility(pool: &PgPool, catalog: &PostgresCatalog) {
    for (mutate, restore) in [
        (
            "UPDATE packages SET visibility='private'",
            "UPDATE packages SET visibility='public' WHERE slug LIKE 'package-%'",
        ),
        (
            "UPDATE packages SET visibility='unlisted' WHERE visibility='public'",
            "UPDATE packages SET visibility='public' WHERE slug LIKE 'package-%'",
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
        hidden(catalog).await;
        execute(pool, restore).await;
        assert_eq!(
            catalog.sitemap_shard(0x42).await.unwrap().len(),
            2,
            "{restore}"
        );
    }
    for (target, source) in [
        ("publisher", "SELECT id::text FROM publishers"),
        (
            "package",
            "SELECT id::text FROM packages WHERE visibility='public'",
        ),
        ("release", "SELECT id::text FROM releases"),
        ("artifact", "SELECT id::text FROM artifacts"),
        (
            "signing_key",
            "SELECT publisher_id::text||':'||key_id FROM publisher_signing_keys",
        ),
    ] {
        let insert = format!(
            "INSERT INTO blocklist_entries SELECT '{target}', value, 'active' FROM ({source}) refs(value)"
        );
        execute(pool, &insert).await;
        hidden(catalog).await;
        execute(pool, "UPDATE blocklist_entries SET status='inactive'").await;
        assert_eq!(catalog.sitemap_shard(0x42).await.unwrap().len(), 2);
        execute(pool, "DELETE FROM blocklist_entries").await;
    }
}

pub(super) async fn overflow(pool: &PgPool, catalog: &PostgresCatalog) {
    execute(pool, "INSERT INTO packages (id,publisher_id,slug,name,kind,status,visibility,summary)
        SELECT ('42'||lpad(to_hex(i+100000),30,'0'))::uuid,
        '10000000-0000-0000-0000-000000000001','overflow-'||i,'Fixture','art','published','public',''
        FROM generate_series(1,4998) i;
        INSERT INTO releases (id,package_id,status) SELECT id,id,'published' FROM packages WHERE slug LIKE 'overflow-%';
        INSERT INTO artifacts (id,release_id,status,canonical_sha256,size_bytes,media_type,published_object_key,signature)
        SELECT id,id,'verified',decode(repeat('aa',32),'hex'),1,'application/zip',
        'sha256/aa/'||repeat('aa',32),'{\"keyId\":\"fixture-key\"}' FROM packages WHERE slug LIKE 'overflow-%';
        INSERT INTO published_release_artifacts SELECT release_id,id FROM artifacts ON CONFLICT DO NOTHING").await;
    assert_eq!(
        catalog.sitemap_shard(0x42).await.unwrap().len(),
        SITEMAP_MAX_SLUGS
    );
    execute(pool, "UPDATE packages SET visibility='public' WHERE slug='filler-66';
        INSERT INTO releases (id,package_id,status) SELECT id,id,'published' FROM packages WHERE slug='filler-66';
        INSERT INTO artifacts (id,release_id,status,canonical_sha256,size_bytes,media_type,published_object_key,signature)
        SELECT id,id,'verified',decode(repeat('aa',32),'hex'),1,'application/zip',
        'sha256/aa/'||repeat('aa',32),'{\"keyId\":\"fixture-key\"}' FROM packages WHERE slug='filler-66';
        INSERT INTO published_release_artifacts SELECT release_id,id FROM artifacts ON CONFLICT DO NOTHING").await;
    assert!(matches!(
        catalog.sitemap_shard(0x42).await,
        Err(CatalogError::Unavailable)
    ));
    assert!(
        catalog
            .sitemap_manifest()
            .await
            .unwrap()
            .iter()
            .any(|id| id == "42")
    );
}

pub(super) async fn database_timeout(pool: &PgPool, catalog: &PostgresCatalog) {
    let original: String = sqlx::query_scalar("SHOW statement_timeout")
        .fetch_one(pool)
        .await
        .unwrap();
    execute(
        pool,
        "UPDATE publishers SET status='active';
        ALTER TABLE packages RENAME TO slow_packages;
        CREATE TEMP VIEW packages AS SELECT * FROM slow_packages WHERE pg_sleep(10) IS NULL",
    )
    .await;
    let started = std::time::Instant::now();
    let error = catalog.sitemap_shard(0x42).await.unwrap_err();
    assert!(matches!(error, CatalogError::Database(ref error)
        if error.as_database_error().and_then(|error| error.code()).as_deref() == Some("57014")));
    assert!(started.elapsed() < Duration::from_secs(3));
    let after: String = sqlx::query_scalar("SHOW statement_timeout")
        .fetch_one(pool)
        .await
        .unwrap();
    assert_eq!(
        after, original,
        "LOCAL timeout must not escape its transaction"
    );
}
