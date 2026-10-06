BEGIN;

CREATE TABLE IF NOT EXISTS edge_policy_projections (
    package_id uuid PRIMARY KEY REFERENCES packages(id) ON DELETE CASCADE,
    public_digest text CHECK (public_digest IS NULL OR public_digest ~ '^[a-f0-9]{64}$'),
    public_policy jsonb,
    revocation_keys text[] NOT NULL DEFAULT '{}'::text[],
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((public_digest IS NULL) = (public_policy IS NULL)),
    CHECK (cardinality(revocation_keys) <= 1000)
);

DROP TRIGGER IF EXISTS edge_policy_projections_updated_at ON edge_policy_projections;
CREATE TRIGGER edge_policy_projections_updated_at BEFORE UPDATE ON edge_policy_projections
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS search_projection_state (
    projection text PRIMARY KEY CHECK (char_length(projection) BETWEEN 1 AND 100),
    active_index text NOT NULL CHECK (char_length(active_index) BETWEEN 1 AND 255),
    rebuilt_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0009_search_and_edge_policy')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
