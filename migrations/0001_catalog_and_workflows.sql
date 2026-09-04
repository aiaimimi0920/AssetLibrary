CREATE EXTENSION IF NOT EXISTS citext;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$;

CREATE TABLE publishers (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
    display_name text NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 160),
    status text NOT NULL CHECK (status IN ('pending', 'active', 'suspended', 'closed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE publisher_members (
    publisher_id uuid NOT NULL REFERENCES publishers(id),
    principal_issuer text NOT NULL CHECK (char_length(principal_issuer) BETWEEN 1 AND 200),
    principal_subject text NOT NULL CHECK (char_length(principal_subject) BETWEEN 1 AND 200),
    role text NOT NULL CHECK (role IN ('owner', 'maintainer', 'release_manager')),
    status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (publisher_id, principal_issuer, principal_subject)
);

CREATE TABLE packages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    publisher_id uuid NOT NULL REFERENCES publishers(id),
    slug citext NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,119}$'),
    kind text NOT NULL CHECK (kind IN ('art', 'capability', 'app_update')),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'submitted', 'published', 'deprecated', 'archived')),
    name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 160),
    summary text NOT NULL DEFAULT '' CHECK (char_length(summary) <= 1000),
    description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 100000),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE releases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id uuid NOT NULL REFERENCES packages(id),
    version text NOT NULL CHECK (char_length(version) BETWEEN 1 AND 100),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'uploading', 'submitted', 'in_review', 'approved', 'published', 'rejected', 'yanked')),
    compatibility jsonb NOT NULL DEFAULT '{}'::jsonb,
    permissions jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_by_issuer text NOT NULL CHECK (char_length(created_by_issuer) BETWEEN 1 AND 200),
    created_by_subject text NOT NULL CHECK (char_length(created_by_subject) BETWEEN 1 AND 200),
    published_at timestamptz,
    yanked_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (package_id, version),
    CHECK ((status = 'published') = (published_at IS NOT NULL) OR status = 'yanked')
);

CREATE TABLE artifacts (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id uuid NOT NULL REFERENCES releases(id),
    status text NOT NULL DEFAULT 'pending_upload' CHECK (status IN ('pending_upload', 'uploaded', 'scanning', 'verified', 'quarantined', 'deleted')),
    object_key text NOT NULL UNIQUE CHECK (char_length(object_key) BETWEEN 1 AND 1024),
    sha256 bytea CHECK (sha256 IS NULL OR octet_length(sha256) = 32),
    size_bytes bigint CHECK (size_bytes IS NULL OR size_bytes BETWEEN 1 AND 10737418240),
    media_type text CHECK (media_type IS NULL OR char_length(media_type) <= 200),
    verified_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((status = 'verified') = (verified_at IS NOT NULL) OR status IN ('quarantined', 'deleted'))
);

CREATE TABLE submissions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    release_id uuid NOT NULL UNIQUE REFERENCES releases(id),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'validated', 'in_review', 'changes_requested', 'approved', 'rejected', 'withdrawn')),
    policy_evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE reviews (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    submission_id uuid NOT NULL REFERENCES submissions(id),
    reviewer_issuer text NOT NULL,
    reviewer_subject text NOT NULL,
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'approved', 'rejected', 'needs_changes')),
    findings jsonb NOT NULL DEFAULT '[]'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (submission_id, reviewer_issuer, reviewer_subject)
);

CREATE TABLE moderation_cases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    package_id uuid NOT NULL REFERENCES packages(id),
    release_id uuid REFERENCES releases(id),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'actioned', 'appealed', 'resolved')),
    reason text NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 4000),
    evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE library_entries (
    principal_issuer text NOT NULL,
    principal_subject text NOT NULL,
    package_id uuid NOT NULL REFERENCES packages(id),
    status text NOT NULL DEFAULT 'listed' CHECK (status IN ('listed', 'hidden', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_issuer, principal_subject, package_id)
);

CREATE TABLE download_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_issuer text NOT NULL,
    principal_subject text NOT NULL,
    artifact_id uuid NOT NULL REFERENCES artifacts(id),
    status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'authorized', 'issued', 'started', 'completed', 'failed', 'expired', 'revoked')),
    ticket_hash bytea CHECK (ticket_hash IS NULL OR octet_length(ticket_hash) = 32),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE install_receipts (
    id uuid PRIMARY KEY,
    principal_issuer text NOT NULL,
    principal_subject text NOT NULL,
    release_id uuid NOT NULL REFERENCES releases(id),
    artifact_id uuid NOT NULL REFERENCES artifacts(id),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'verified', 'revoked', 'superseded')),
    installed_digest bytea NOT NULL CHECK (octet_length(installed_digest) = 32),
    installed_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_issuer, principal_subject, id)
);

CREATE TABLE ratings (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_issuer text NOT NULL,
    principal_subject text NOT NULL,
    package_id uuid NOT NULL REFERENCES packages(id),
    install_receipt_id uuid NOT NULL REFERENCES install_receipts(id),
    score smallint NOT NULL CHECK (score BETWEEN 1 AND 5),
    review_text text NOT NULL DEFAULT '' CHECK (char_length(review_text) <= 10000),
    status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'published', 'flagged', 'removed')),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (principal_issuer, principal_subject, package_id)
);

CREATE TABLE idempotency_keys (
    principal_issuer text NOT NULL,
    principal_subject text NOT NULL,
    operation text NOT NULL,
    idempotency_key text NOT NULL,
    request_digest bytea NOT NULL CHECK (octet_length(request_digest) = 32),
    response_status integer,
    response_body jsonb,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (principal_issuer, principal_subject, operation, idempotency_key)
);

CREATE TABLE audit_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    occurred_at timestamptz NOT NULL DEFAULT now(),
    actor_issuer text,
    actor_subject text,
    action text NOT NULL,
    resource_type text NOT NULL,
    resource_id uuid,
    correlation_id text NOT NULL,
    details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE outbox_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    subject text NOT NULL,
    schema_version text NOT NULL,
    aggregate_type text NOT NULL,
    aggregate_id uuid NOT NULL,
    payload jsonb NOT NULL,
    occurred_at timestamptz NOT NULL DEFAULT now(),
    published_at timestamptz,
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    last_error text
);

CREATE INDEX packages_public_list_idx ON packages (kind, updated_at DESC, id) WHERE status = 'published';
CREATE INDEX releases_package_idx ON releases (package_id, created_at DESC);
CREATE INDEX artifacts_release_idx ON artifacts (release_id, status);
CREATE INDEX download_sessions_principal_idx ON download_sessions (principal_issuer, principal_subject, created_at DESC);
CREATE INDEX outbox_unpublished_idx ON outbox_events (occurred_at, id) WHERE published_at IS NULL;
CREATE INDEX audit_resource_idx ON audit_events (resource_type, resource_id, occurred_at DESC);

CREATE TRIGGER publishers_updated_at BEFORE UPDATE ON publishers FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER publisher_members_updated_at BEFORE UPDATE ON publisher_members FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER packages_updated_at BEFORE UPDATE ON packages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER releases_updated_at BEFORE UPDATE ON releases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER artifacts_updated_at BEFORE UPDATE ON artifacts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER submissions_updated_at BEFORE UPDATE ON submissions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER reviews_updated_at BEFORE UPDATE ON reviews FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER moderation_cases_updated_at BEFORE UPDATE ON moderation_cases FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER library_entries_updated_at BEFORE UPDATE ON library_entries FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER download_sessions_updated_at BEFORE UPDATE ON download_sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER ratings_updated_at BEFORE UPDATE ON ratings FOR EACH ROW EXECUTE FUNCTION set_updated_at();
