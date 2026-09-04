CREATE TABLE IF NOT EXISTS publisher_signing_keys (
    publisher_id uuid NOT NULL REFERENCES publishers(id),
    key_id text NOT NULL CHECK (char_length(key_id) BETWEEN 1 AND 160),
    public_key bytea NOT NULL CHECK (octet_length(public_key) = 32),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    revoked_at timestamptz,
    PRIMARY KEY (publisher_id, key_id),
    CHECK ((status = 'revoked') = (revoked_at IS NOT NULL))
);

ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS canonical_sha256 bytea;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS published_object_key text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS scanner_version text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS rule_version text;
ALTER TABLE artifacts ADD COLUMN IF NOT EXISTS scan_evidence jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_canonical_sha256_length;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_canonical_sha256_length
    CHECK (canonical_sha256 IS NULL OR octet_length(canonical_sha256) = 32);
ALTER TABLE artifacts DROP CONSTRAINT IF EXISTS artifacts_published_object_key_length;
ALTER TABLE artifacts ADD CONSTRAINT artifacts_published_object_key_length
    CHECK (published_object_key IS NULL OR char_length(published_object_key) BETWEEN 1 AND 1024);
CREATE UNIQUE INDEX IF NOT EXISTS artifacts_published_object_key_unique
    ON artifacts (published_object_key) WHERE published_object_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS artifact_scan_attempts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    artifact_id uuid NOT NULL REFERENCES artifacts(id),
    event_id uuid NOT NULL,
    delivery_count integer NOT NULL CHECK (delivery_count BETWEEN 1 AND 20),
    result text NOT NULL CHECK (result IN ('started', 'verified', 'quarantined', 'retry')),
    failure_code text CHECK (failure_code IS NULL OR char_length(failure_code) BETWEEN 1 AND 100),
    scanner_version text NOT NULL CHECK (char_length(scanner_version) BETWEEN 1 AND 100),
    rule_version text NOT NULL CHECK (char_length(rule_version) BETWEEN 1 AND 100),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (event_id, delivery_count)
);

CREATE INDEX IF NOT EXISTS artifact_scan_attempts_artifact_idx
    ON artifact_scan_attempts (artifact_id, created_at DESC);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0003_scanner_trust_and_evidence')
ON CONFLICT (migration_id) DO NOTHING;
