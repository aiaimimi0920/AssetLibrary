BEGIN;

CREATE INDEX IF NOT EXISTS moderation_cases_publisher_list_idx
    ON moderation_cases (package_id, created_at DESC, id)
    WHERE status IN ('actioned', 'appealed', 'resolved');

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0015_publisher_moderation_cases')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
