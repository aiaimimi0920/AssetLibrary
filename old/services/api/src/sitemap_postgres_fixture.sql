-- Disposable temporary projection tables mirror the production column types
-- and relevant indexes. No real schema, account, artifact bytes, or keys are used.
CREATE TEMP TABLE publishers (
    id uuid PRIMARY KEY, slug text NOT NULL, display_name text NOT NULL, status text NOT NULL
);
CREATE TEMP TABLE packages (
    id uuid PRIMARY KEY, publisher_id uuid NOT NULL REFERENCES publishers(id),
    slug text NOT NULL UNIQUE, name text NOT NULL, kind text NOT NULL,
    status text NOT NULL, visibility text NOT NULL, summary text NOT NULL,
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX packages_public_list_idx ON packages (kind, updated_at DESC, id)
    WHERE status = 'published';
CREATE INDEX packages_public_publisher_list_idx ON packages (publisher_id, updated_at DESC, id)
    WHERE status = 'published' AND visibility = 'public';
CREATE TEMP TABLE releases (
    id uuid PRIMARY KEY, package_id uuid NOT NULL REFERENCES packages(id),
    status text NOT NULL, published_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX releases_public_package_list_idx ON releases (package_id, published_at DESC, id)
    WHERE status = 'published';
CREATE TEMP TABLE artifacts (
    id uuid PRIMARY KEY, release_id uuid NOT NULL REFERENCES releases(id),
    status text NOT NULL, canonical_sha256 bytea, size_bytes bigint, media_type text,
    published_object_key text, signature jsonb,
    UNIQUE (release_id, id)
);
CREATE TEMP TABLE published_release_artifacts (
    release_id uuid NOT NULL, artifact_id uuid NOT NULL UNIQUE,
    PRIMARY KEY (release_id, artifact_id),
    FOREIGN KEY (release_id, artifact_id) REFERENCES artifacts(release_id, id)
);
CREATE TEMP TABLE publisher_signing_keys (
    publisher_id uuid NOT NULL REFERENCES publishers(id), key_id text NOT NULL,
    status text NOT NULL, PRIMARY KEY (publisher_id, key_id)
);
CREATE TEMP TABLE blocklist_entries (
    target_type text NOT NULL, target_ref text NOT NULL, status text NOT NULL
);
CREATE INDEX blocklist_active_target_idx ON blocklist_entries (target_type, target_ref)
    WHERE status = 'active';

INSERT INTO publishers VALUES ('10000000-0000-0000-0000-000000000001', 'fixture', 'Fixture', 'active');
INSERT INTO publisher_signing_keys VALUES ('10000000-0000-0000-0000-000000000001', 'fixture-key', 'active');
INSERT INTO packages (id, publisher_id, slug, name, kind, status, visibility, summary)
SELECT (lpad(to_hex(shard), 2, '0') || repeat(edge, 30))::uuid,
    '10000000-0000-0000-0000-000000000001',
    'package-' || lpad(to_hex(shard), 2, '0') || '-' || edge,
    'Synthetic boundary', 'art', 'published', 'public', ''
FROM generate_series(0, 255) shard CROSS JOIN (VALUES ('0'), ('f')) edges(edge);
-- Enough uniformly distributed ineligible rows for a meaningful normal planner
-- choice. Neither enable_seqscan nor other planner methods are disabled.
INSERT INTO packages (id, publisher_id, slug, name, kind, status, visibility, summary)
SELECT (lpad(to_hex(i % 256), 2, '0') || lpad(to_hex(i + 1), 30, '0'))::uuid,
    '10000000-0000-0000-0000-000000000001', 'filler-' || i,
    'Synthetic private', 'art', 'published', 'private', ''
FROM generate_series(0, 65535) i;
INSERT INTO releases (id, package_id, status)
SELECT id, id, 'published' FROM packages WHERE visibility = 'public';
INSERT INTO artifacts (id, release_id, status, canonical_sha256, size_bytes, media_type, published_object_key, signature)
SELECT id, id, 'verified', decode(repeat('aa', 32), 'hex'), 1,
    'application/zip', 'sha256/aa/' || repeat('aa', 32), '{"keyId":"fixture-key"}'
FROM releases;
INSERT INTO published_release_artifacts SELECT release_id, id FROM artifacts;
ANALYZE publishers;
ANALYZE packages;
ANALYZE releases;
ANALYZE artifacts;
ANALYZE published_release_artifacts;
ANALYZE publisher_signing_keys;
ANALYZE blocklist_entries;
