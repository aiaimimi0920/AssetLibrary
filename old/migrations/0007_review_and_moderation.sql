BEGIN;

ALTER TABLE packages DROP CONSTRAINT IF EXISTS packages_status_check;
ALTER TABLE packages ADD CONSTRAINT packages_status_check
    CHECK (status IN ('draft', 'submitted', 'published', 'suspended', 'deprecated', 'archived'));

ALTER TABLE submissions
    ADD COLUMN IF NOT EXISTS artifact_id uuid REFERENCES artifacts(id),
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS required_approvals smallint NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS submitted_by_issuer text,
    ADD COLUMN IF NOT EXISTS submitted_by_subject text,
    ADD COLUMN IF NOT EXISTS policy_version text,
    ADD COLUMN IF NOT EXISTS scanner_version text,
    ADD COLUMN IF NOT EXISTS rule_version text,
    ADD COLUMN IF NOT EXISTS submitted_at timestamptz,
    ADD COLUMN IF NOT EXISTS decided_at timestamptz;

ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_revision_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_revision_check CHECK (revision BETWEEN 1 AND 10000);
ALTER TABLE submissions DROP CONSTRAINT IF EXISTS submissions_required_approvals_check;
ALTER TABLE submissions ADD CONSTRAINT submissions_required_approvals_check CHECK (required_approvals IN (1, 2));

ALTER TABLE reviews
    ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS reason text NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    ADD COLUMN IF NOT EXISTS decided_at timestamptz;

ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_submission_id_reviewer_issuer_reviewer_subject_key;
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_reason_length;
ALTER TABLE reviews ADD CONSTRAINT reviews_reason_length CHECK (char_length(reason) <= 4000);
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_revision_check;
ALTER TABLE reviews ADD CONSTRAINT reviews_revision_check CHECK (revision BETWEEN 1 AND 10000);
ALTER TABLE reviews DROP CONSTRAINT IF EXISTS reviews_submission_revision_reviewer_key;
ALTER TABLE reviews ADD CONSTRAINT reviews_submission_revision_reviewer_key
    UNIQUE (submission_id, revision, reviewer_issuer, reviewer_subject);

CREATE TABLE IF NOT EXISTS store_roles (
    principal_issuer text NOT NULL CHECK (char_length(principal_issuer) BETWEEN 1 AND 200),
    principal_subject text NOT NULL CHECK (char_length(principal_subject) BETWEEN 1 AND 200),
    role text NOT NULL CHECK (role IN ('reviewer', 'moderator', 'operator')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_issuer, principal_subject, role)
);

ALTER TABLE moderation_cases
    ADD COLUMN IF NOT EXISTS reporter_issuer text,
    ADD COLUMN IF NOT EXISTS reporter_subject text,
    ADD COLUMN IF NOT EXISTS evidence_urls jsonb NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS appeal_reason text,
    ADD COLUMN IF NOT EXISTS resolution text,
    ADD COLUMN IF NOT EXISTS resolution_reason text,
    ADD COLUMN IF NOT EXISTS resolved_at timestamptz;

ALTER TABLE moderation_cases DROP CONSTRAINT IF EXISTS moderation_cases_resolution_check;
ALTER TABLE moderation_cases ADD CONSTRAINT moderation_cases_resolution_check
    CHECK (resolution IS NULL OR resolution IN ('upheld', 'block_lifted'));

CREATE TABLE IF NOT EXISTS moderation_actions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    case_id uuid NOT NULL REFERENCES moderation_cases(id),
    action text NOT NULL CHECK (action IN ('suspend', 'yank', 'revoke', 'block')),
    target_type text NOT NULL CHECK (target_type IN ('publisher', 'package', 'release', 'artifact', 'signing_key')),
    target_ref text NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 200),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
    status text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'applied')),
    requested_by_issuer text NOT NULL,
    requested_by_subject text NOT NULL,
    approved_by_issuer text,
    approved_by_subject text,
    created_at timestamptz NOT NULL DEFAULT now(),
    applied_at timestamptz,
    CHECK ((status = 'applied') = (applied_at IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS blocklist_entries (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    target_type text NOT NULL CHECK (target_type IN ('publisher', 'package', 'release', 'artifact', 'signing_key')),
    target_ref text NOT NULL CHECK (char_length(target_ref) BETWEEN 1 AND 200),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'lifted')),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
    source_action_id uuid NOT NULL UNIQUE REFERENCES moderation_actions(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    lifted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS blocklist_active_target_idx
    ON blocklist_entries (target_type, target_ref) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS review_queue_idx ON submissions (status, updated_at, id) WHERE status = 'in_review';
CREATE INDEX IF NOT EXISTS reviews_current_decision_idx ON reviews (submission_id, revision, status);
CREATE INDEX IF NOT EXISTS moderation_actions_case_idx ON moderation_actions (case_id, created_at, id);

DROP TRIGGER IF EXISTS store_roles_updated_at ON store_roles;
CREATE TRIGGER store_roles_updated_at BEFORE UPDATE ON store_roles
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0007_review_and_moderation')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
