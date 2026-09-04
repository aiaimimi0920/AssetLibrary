BEGIN;

UPDATE upload_sessions AS us
SET status = 'deleted',
    expires_at = LEAST(us.expires_at, now()),
    cleanup_error = 'artifact_exceeds_scannable_limit'
FROM artifacts AS a
WHERE a.id = us.artifact_id
  AND (a.size_bytes > 2147483648 OR us.part_size_bytes > 2147483648)
  AND us.status IN ('pending_upload', 'uploaded', 'scanning');

UPDATE artifacts
SET status = 'deleted'
WHERE size_bytes > 2147483648
  AND status IN ('pending_upload', 'uploaded', 'scanning');

-- Terminal legacy records retain their real artifact size. Multipart sizing is
-- no longer operational after upload, so it can be normalized for cleanup.
UPDATE upload_sessions
SET part_size_bytes = 2147483648
WHERE part_size_bytes > 2147483648;

ALTER TABLE artifacts
    DROP CONSTRAINT IF EXISTS artifacts_size_bytes_check;

ALTER TABLE artifacts
    ADD CONSTRAINT artifacts_size_bytes_check
    CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 2147483648)
    NOT VALID;

ALTER TABLE upload_sessions
    DROP CONSTRAINT IF EXISTS upload_sessions_part_size_bytes_check;

ALTER TABLE upload_sessions
    ADD CONSTRAINT upload_sessions_part_size_bytes_check
    CHECK (part_size_bytes BETWEEN 5242880 AND 2147483648);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0006_scannable_artifact_limit')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
