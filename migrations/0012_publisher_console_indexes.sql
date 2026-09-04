BEGIN;

CREATE INDEX IF NOT EXISTS publisher_members_principal_active_idx
    ON publisher_members (principal_issuer, principal_subject, publisher_id)
    WHERE status = 'active';

CREATE INDEX IF NOT EXISTS packages_owned_publisher_updated_idx
    ON packages (publisher_id, updated_at DESC, id);

CREATE INDEX IF NOT EXISTS releases_owned_package_created_idx
    ON releases (package_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION protect_release_creator()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF OLD.created_by_issuer IS DISTINCT FROM NEW.created_by_issuer
       OR OLD.created_by_subject IS DISTINCT FROM NEW.created_by_subject THEN
        RAISE EXCEPTION 'release creator is immutable';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_release_creator_fields ON releases;
CREATE TRIGGER protect_release_creator_fields
    BEFORE UPDATE ON releases
    FOR EACH ROW EXECUTE FUNCTION protect_release_creator();

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0012_publisher_console_indexes')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
