BEGIN;

ALTER TABLE releases
    ALTER COLUMN compatibility SET DEFAULT '{"products":[]}'::jsonb;

UPDATE releases
SET compatibility = '{"products":[]}'::jsonb
WHERE compatibility = '{}'::jsonb;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'submissions_in_review_metadata_check'
          AND conrelid = 'submissions'::regclass
    ) THEN
        ALTER TABLE submissions
            ADD CONSTRAINT submissions_in_review_metadata_check
            CHECK (
                status <> 'in_review'
                OR (
                    artifact_id IS NOT NULL
                    AND submitted_by_issuer IS NOT NULL
                    AND submitted_by_subject IS NOT NULL
                    AND policy_version IS NOT NULL
                    AND scanner_version IS NOT NULL
                    AND rule_version IS NOT NULL
                    AND submitted_at IS NOT NULL
                )
            ) NOT VALID;
    END IF;
END
$$;

ALTER TABLE submissions VALIDATE CONSTRAINT submissions_in_review_metadata_check;

CREATE INDEX IF NOT EXISTS review_queue_submitted_idx
    ON submissions (submitted_at, id)
    WHERE status = 'in_review' AND submitted_at IS NOT NULL;

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0013_operator_review_queue')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
