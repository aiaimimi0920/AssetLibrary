BEGIN;

CREATE INDEX IF NOT EXISTS packages_public_publisher_list_idx
    ON packages (publisher_id, updated_at DESC, id)
    WHERE status = 'published' AND visibility = 'public';

CREATE INDEX IF NOT EXISTS releases_public_package_list_idx
    ON releases (package_id, published_at DESC, id)
    WHERE status = 'published';

INSERT INTO migration_checkpoints (migration_id)
VALUES ('0010_public_catalog_read_indexes')
ON CONFLICT (migration_id) DO NOTHING;

COMMIT;
