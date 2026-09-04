BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'artifacts_release_id_id_key'
          AND conrelid = 'artifacts'::regclass
    ) THEN
        ALTER TABLE artifacts ADD CONSTRAINT artifacts_release_id_id_key
            UNIQUE (release_id, id);
    END IF;
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'submissions_id_release_id_artifact_id_key'
          AND conrelid = 'submissions'::regclass
    ) THEN
        ALTER TABLE submissions ADD CONSTRAINT submissions_id_release_id_artifact_id_key
            UNIQUE (id, release_id, artifact_id);
    END IF;
END
$$;

CREATE TABLE IF NOT EXISTS published_release_artifacts (
    release_id uuid NOT NULL,
    artifact_id uuid NOT NULL,
    approval_submission_id uuid,
    source text NOT NULL,
    published_at timestamptz NOT NULL,
    CONSTRAINT published_release_artifacts_pkey PRIMARY KEY (release_id, artifact_id),
    CONSTRAINT published_release_artifacts_artifact_id_key UNIQUE (artifact_id),
    CONSTRAINT published_release_artifacts_release_id_artifact_id_fkey
        FOREIGN KEY (release_id, artifact_id) REFERENCES artifacts(release_id, id),
    CONSTRAINT published_release_artifacts_approval_submission_id_release_fkey
        FOREIGN KEY (approval_submission_id, release_id, artifact_id)
        REFERENCES submissions(id, release_id, artifact_id),
    CONSTRAINT published_release_artifacts_source_check
        CHECK (source IN ('reviewed_submission', 'legacy_backfill')),
    CONSTRAINT published_release_artifacts_check
        CHECK ((source = 'reviewed_submission') = (approval_submission_id IS NOT NULL))
);

DO $$
DECLARE
    required_definition text;
BEGIN
    IF (
        SELECT count(*) FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'published_release_artifacts'
          AND column_name IN ('release_id', 'artifact_id', 'source', 'published_at')
          AND is_nullable = 'NO'
    ) <> 4 THEN
        RAISE EXCEPTION 'published_release_artifacts has an invalid required-column shape';
    END IF;
    FOREACH required_definition IN ARRAY ARRAY[
        'PRIMARY KEY (release_id, artifact_id)',
        'UNIQUE (artifact_id)',
        'FOREIGN KEY (release_id, artifact_id) REFERENCES artifacts(release_id, id)',
        'FOREIGN KEY (approval_submission_id, release_id, artifact_id) REFERENCES submissions(id, release_id, artifact_id)',
        'CHECK ((source = ANY (ARRAY[''reviewed_submission''::text, ''legacy_backfill''::text])))',
        'CHECK (((source = ''reviewed_submission''::text) = (approval_submission_id IS NOT NULL)))'
    ]
    LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
            WHERE conrelid = 'published_release_artifacts'::regclass
              AND pg_get_constraintdef(oid) = required_definition
        ) THEN
            RAISE EXCEPTION 'published_release_artifacts is missing constraint: %', required_definition;
        END IF;
    END LOOP;
END
$$;

INSERT INTO published_release_artifacts (
    release_id, artifact_id, approval_submission_id, source, published_at
)
SELECT r.id, s.artifact_id, s.id, 'reviewed_submission', COALESCE(r.published_at, now())
FROM releases r
JOIN submissions s ON s.release_id = r.id AND s.status = 'approved'
JOIN artifacts a ON a.release_id = r.id AND a.id = s.artifact_id
WHERE r.status IN ('published', 'yanked')
ON CONFLICT (release_id, artifact_id) DO NOTHING;

WITH legacy_candidates AS (
    SELECT r.id AS release_id, (array_agg(a.id ORDER BY a.id))[1] AS artifact_id,
        COALESCE(r.published_at, now()) AS published_at
    FROM releases r
    JOIN artifacts a ON a.release_id = r.id
    WHERE r.status IN ('published', 'yanked')
      AND NOT EXISTS (
          SELECT 1 FROM published_release_artifacts published WHERE published.release_id = r.id
      )
    GROUP BY r.id, r.published_at
    HAVING count(*) = 1
       AND bool_and(
           a.canonical_sha256 IS NOT NULL
           AND a.size_bytes IS NOT NULL
           AND a.media_type IS NOT NULL
           AND a.signature->>'keyId' IS NOT NULL
           AND a.published_object_key = 'sha256/' || left(encode(a.canonical_sha256, 'hex'), 2)
             || '/' || encode(a.canonical_sha256, 'hex')
       )
)
INSERT INTO published_release_artifacts (
    release_id, artifact_id, approval_submission_id, source, published_at
)
SELECT release_id, artifact_id, NULL, 'legacy_backfill', published_at
FROM legacy_candidates
ON CONFLICT (release_id, artifact_id) DO NOTHING;

DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM releases r
        WHERE r.status IN ('published', 'yanked')
          AND NOT EXISTS (
              SELECT 1 FROM published_release_artifacts published WHERE published.release_id = r.id
          )
    ) THEN
        RAISE EXCEPTION 'published or yanked release has no unambiguous publication artifact';
    END IF;
END
$$;

CREATE OR REPLACE FUNCTION enforce_release_publication_binding()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.status IN ('published', 'yanked')) <> EXISTS (
        SELECT 1 FROM published_release_artifacts published WHERE published.release_id = NEW.id
    ) THEN
        RAISE EXCEPTION 'release publication state and artifact binding disagree';
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION enforce_publication_binding_release()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    affected_release_id uuid;
    release_status text;
BEGIN
    affected_release_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.release_id ELSE NEW.release_id END;
    SELECT status INTO release_status FROM releases WHERE id = affected_release_id;
    IF release_status IS NOT NULL
       AND ((release_status IN ('published', 'yanked')) <> EXISTS (
           SELECT 1 FROM published_release_artifacts published
           WHERE published.release_id = affected_release_id
       )) THEN
        RAISE EXCEPTION 'release publication state and artifact binding disagree';
    END IF;
    RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION protect_published_release_artifact()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.release_id IS DISTINCT FROM NEW.release_id
       OR OLD.artifact_id IS DISTINCT FROM NEW.artifact_id
       OR OLD.published_at IS DISTINCT FROM NEW.published_at
       OR OLD.source <> 'legacy_backfill'
       OR NEW.source <> 'reviewed_submission'
       OR OLD.approval_submission_id IS NOT NULL
       OR NEW.approval_submission_id IS NULL THEN
        RAISE EXCEPTION 'published release artifact facts are immutable';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS releases_publication_binding ON releases;
CREATE CONSTRAINT TRIGGER releases_publication_binding
    AFTER INSERT OR UPDATE ON releases
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_release_publication_binding();

DROP TRIGGER IF EXISTS published_artifacts_release_binding ON published_release_artifacts;
CREATE CONSTRAINT TRIGGER published_artifacts_release_binding
    AFTER INSERT OR UPDATE OR DELETE ON published_release_artifacts
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION enforce_publication_binding_release();

DROP TRIGGER IF EXISTS protect_published_release_artifacts ON published_release_artifacts;
CREATE TRIGGER protect_published_release_artifacts
    BEFORE UPDATE ON published_release_artifacts
    FOR EACH ROW EXECUTE FUNCTION protect_published_release_artifact();

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0011_published_release_artifacts')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
