ALTER TABLE artifacts
    ADD COLUMN IF NOT EXISTS media_type text,
    ADD COLUMN IF NOT EXISTS manifest jsonb,
    ADD COLUMN IF NOT EXISTS signature jsonb,
    ADD COLUMN IF NOT EXISTS sbom_digest bytea,
    ADD COLUMN IF NOT EXISTS provenance_digest bytea,
    ADD COLUMN IF NOT EXISTS scan_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS last_scan_error text;

ALTER TABLE artifacts
    DROP CONSTRAINT IF EXISTS artifacts_sha256_check;

ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_sha256_check
    CHECK (sha256 IS NULL OR octet_length(sha256) = 32);

ALTER TABLE artifacts
    DROP CONSTRAINT IF EXISTS artifacts_scan_attempts_check;

ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_scan_attempts_check
    CHECK (scan_attempts >= 0 AND scan_attempts <= 20);

ALTER TABLE audit_events
    DROP CONSTRAINT IF EXISTS audit_events_correlation_id_check;

ALTER TABLE audit_events
    ADD CONSTRAINT audit_events_correlation_id_check
    CHECK (char_length(correlation_id) BETWEEN 1 AND 128);

CREATE INDEX IF NOT EXISTS artifacts_status_scan_idx
    ON artifacts (status, updated_at, id);

CREATE TABLE IF NOT EXISTS upload_sessions (
    id uuid PRIMARY KEY,
    release_id uuid NOT NULL REFERENCES releases(id),
    artifact_id uuid NOT NULL UNIQUE REFERENCES artifacts(id),
    principal_issuer text NOT NULL,
    principal_subject text NOT NULL,
    idempotency_key text NOT NULL CHECK (char_length(idempotency_key) BETWEEN 8 AND 200),
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    object_key text NOT NULL UNIQUE,
    part_size_bytes bigint NOT NULL CHECK (part_size_bytes BETWEEN 5242880 AND 10737418240),
    max_parts integer NOT NULL CHECK (max_parts BETWEEN 1 AND 10000),
    expires_at timestamptz NOT NULL,
    status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'uploaded', 'scanning', 'verified', 'quarantined', 'deleted')),
    expected_digest jsonb NOT NULL,
    storage_upload_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_issuer, principal_subject, idempotency_key)
);

CREATE INDEX IF NOT EXISTS upload_sessions_release_idx
    ON upload_sessions (release_id, created_at DESC);

ALTER TABLE upload_sessions
    ADD COLUMN IF NOT EXISTS storage_upload_id text;

DROP TRIGGER IF EXISTS upload_sessions_updated_at ON upload_sessions;
CREATE TRIGGER upload_sessions_updated_at BEFORE UPDATE ON upload_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS migration_checkpoints (
    migration_id text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0002_artifact_supply_chain')
ON CONFLICT (migration_id) DO NOTHING;
