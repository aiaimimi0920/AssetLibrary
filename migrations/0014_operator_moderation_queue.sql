BEGIN;

DO $$
BEGIN
    IF EXISTS (
        SELECT case_id FROM moderation_actions
        GROUP BY case_id HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION 'moderation case has multiple actions';
    END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS moderation_actions_one_per_case_idx
    ON moderation_actions (case_id);

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moderation_actions_approval_actor_check'
          AND conrelid = 'moderation_actions'::regclass
    ) THEN
        ALTER TABLE moderation_actions
            ADD CONSTRAINT moderation_actions_approval_actor_check
            CHECK (
                (status = 'proposed' AND approved_by_issuer IS NULL AND approved_by_subject IS NULL)
                OR (
                    status = 'applied'
                    AND approved_by_issuer IS NOT NULL
                    AND approved_by_subject IS NOT NULL
                    AND (requested_by_issuer, requested_by_subject)
                        IS DISTINCT FROM (approved_by_issuer, approved_by_subject)
                )
            ) NOT VALID;
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'moderation_cases_state_metadata_check'
          AND conrelid = 'moderation_cases'::regclass
    ) THEN
        ALTER TABLE moderation_cases
            ADD CONSTRAINT moderation_cases_state_metadata_check
            CHECK (
                jsonb_typeof(evidence_urls) = 'array'
                AND jsonb_array_length(evidence_urls) <= 20
                AND (
                    (status IN ('open', 'actioned') AND appeal_reason IS NULL
                        AND resolution IS NULL AND resolution_reason IS NULL AND resolved_at IS NULL)
                    OR (status = 'appealed' AND appeal_reason IS NOT NULL
                        AND resolution IS NULL AND resolution_reason IS NULL AND resolved_at IS NULL)
                    OR (status = 'resolved' AND appeal_reason IS NOT NULL
                        AND resolution IS NOT NULL AND resolution_reason IS NOT NULL AND resolved_at IS NOT NULL)
                )
            ) NOT VALID;
    END IF;
END
$$;

ALTER TABLE moderation_actions
    VALIDATE CONSTRAINT moderation_actions_approval_actor_check;
ALTER TABLE moderation_cases
    VALIDATE CONSTRAINT moderation_cases_state_metadata_check;

CREATE INDEX IF NOT EXISTS moderation_cases_operator_queue_idx
    ON moderation_cases (created_at, id)
    WHERE status <> 'resolved';

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0014_operator_moderation_queue')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
