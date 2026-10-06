ALTER TABLE upload_sessions
    ADD COLUMN IF NOT EXISTS cleanup_claimed_at timestamptz,
    ADD COLUMN IF NOT EXISTS cleanup_worker text,
    ADD COLUMN IF NOT EXISTS cleanup_attempts integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS cleanup_error text,
    ADD COLUMN IF NOT EXISTS cleaned_at timestamptz;

ALTER TABLE upload_sessions
    DROP CONSTRAINT IF EXISTS upload_sessions_cleanup_attempts_check;

ALTER TABLE upload_sessions
    ADD CONSTRAINT upload_sessions_cleanup_attempts_check
    CHECK (cleanup_attempts >= 0 AND cleanup_attempts <= 20);

CREATE INDEX IF NOT EXISTS upload_sessions_cleanup_idx
    ON upload_sessions (cleaned_at, cleanup_claimed_at, expires_at, id);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0005_quarantine_cleanup')
ON CONFLICT (migration_id) DO NOTHING;
