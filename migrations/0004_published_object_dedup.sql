DROP INDEX IF EXISTS artifacts_published_object_key_unique;

CREATE INDEX IF NOT EXISTS artifacts_published_object_key_idx
    ON artifacts (published_object_key)
    WHERE published_object_key IS NOT NULL;

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0004_published_object_dedup')
ON CONFLICT (migration_id) DO NOTHING;
