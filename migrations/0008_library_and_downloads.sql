BEGIN;

ALTER TABLE packages
    ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public',
    ADD COLUMN IF NOT EXISTS tags text[] NOT NULL DEFAULT '{}'::text[];
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_visibility_check;
ALTER TABLE packages ADD CONSTRAINT packages_visibility_check
    CHECK (visibility IN ('public', 'unlisted', 'private'));
ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_tags_count_check;
ALTER TABLE packages ADD CONSTRAINT packages_tags_count_check
    CHECK (cardinality(tags) <= 32);

ALTER TABLE library_entries
    ADD COLUMN IF NOT EXISTS favorite boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS installed_release_id uuid REFERENCES releases(id),
    ADD COLUMN IF NOT EXISTS installed_artifact_id uuid REFERENCES artifacts(id);

ALTER TABLE download_sessions
    ADD COLUMN IF NOT EXISTS package_id uuid REFERENCES packages(id),
    ADD COLUMN IF NOT EXISTS release_id uuid REFERENCES releases(id),
    ADD COLUMN IF NOT EXISTS publisher_id uuid REFERENCES publishers(id),
    ADD COLUMN IF NOT EXISTS object_key text,
    ADD COLUMN IF NOT EXISTS digest bytea,
    ADD COLUMN IF NOT EXISTS nonce uuid,
    ADD COLUMN IF NOT EXISTS audience text,
    ADD COLUMN IF NOT EXISTS purpose text,
    ADD COLUMN IF NOT EXISTS client_type text,
    ADD COLUMN IF NOT EXISTS idempotency_key text,
    ADD COLUMN IF NOT EXISTS request_digest bytea,
    ADD COLUMN IF NOT EXISTS issued_at timestamptz,
    ADD COLUMN IF NOT EXISTS completed_at timestamptz;

ALTER TABLE download_sessions DROP CONSTRAINT IF EXISTS download_sessions_digest_check;
ALTER TABLE download_sessions ADD CONSTRAINT download_sessions_digest_check
    CHECK (digest IS NULL OR octet_length(digest) = 32);
ALTER TABLE download_sessions DROP CONSTRAINT IF EXISTS download_sessions_request_digest_check;
ALTER TABLE download_sessions ADD CONSTRAINT download_sessions_request_digest_check
    CHECK (request_digest IS NULL OR octet_length(request_digest) = 32);
ALTER TABLE download_sessions DROP CONSTRAINT IF EXISTS download_sessions_purpose_check;
ALTER TABLE download_sessions ADD CONSTRAINT download_sessions_purpose_check
    CHECK (purpose IS NULL OR purpose = 'download');
ALTER TABLE download_sessions DROP CONSTRAINT IF EXISTS download_sessions_client_type_check;
ALTER TABLE download_sessions ADD CONSTRAINT download_sessions_client_type_check
    CHECK (client_type IS NULL OR client_type IN ('web', 'loom', 'hook', 'cli'));

CREATE UNIQUE INDEX IF NOT EXISTS download_sessions_nonce_idx
    ON download_sessions (nonce) WHERE nonce IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS download_sessions_idempotency_idx
    ON download_sessions (principal_issuer, principal_subject, idempotency_key)
    WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS download_sessions_artifact_status_idx
    ON download_sessions (artifact_id, status, expires_at);
CREATE INDEX IF NOT EXISTS library_entries_principal_updated_idx
    ON library_entries (principal_issuer, principal_subject, updated_at DESC, package_id);
CREATE INDEX IF NOT EXISTS packages_tags_idx ON packages USING gin (tags);

CREATE TABLE IF NOT EXISTS projection_events (
    projection text NOT NULL CHECK (char_length(projection) BETWEEN 1 AND 100),
    event_id uuid NOT NULL,
    aggregate_id uuid NOT NULL,
    processed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (projection, event_id)
);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0008_library_and_downloads')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
