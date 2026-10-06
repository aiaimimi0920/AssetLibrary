-- 发布是审核之后的独立事实；下架终态不重置版本或历史授权。
CREATE TABLE publications (
  id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL UNIQUE REFERENCES versions(id),
  version_revision INTEGER NOT NULL CHECK(version_revision > 0),
  scan_result TEXT NOT NULL CHECK(json_valid(scan_result)),
  state TEXT NOT NULL CHECK(state IN ('published', 'unlisted')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_operation TEXT NOT NULL
) STRICT;
CREATE INDEX publications_page ON publications(state, id);
CREATE TABLE publication_events (
  operation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('published', 'unlisted')),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(publication_id, revision)
) STRICT;
CREATE TABLE download_grants (
  publication_id TEXT NOT NULL REFERENCES publications(id),
  principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK(state IN ('active', 'revoked')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  updated_at INTEGER NOT NULL,
  last_operation TEXT NOT NULL,
  PRIMARY KEY(publication_id, principal)
) STRICT;
CREATE INDEX download_grants_library ON download_grants(principal, state, publication_id);
CREATE TABLE download_grant_events (
  operation_id TEXT PRIMARY KEY,
  publication_id TEXT NOT NULL,
  principal TEXT NOT NULL,
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('active', 'revoked')),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY(publication_id, principal) REFERENCES download_grants(publication_id, principal),
  UNIQUE(publication_id, principal, revision)
) STRICT;
CREATE TABLE download_tickets (
  token_hash TEXT PRIMARY KEY CHECK(length(token_hash) = 64),
  principal TEXT NOT NULL,
  publication_id TEXT NOT NULL REFERENCES publications(id),
  publication_revision INTEGER NOT NULL,
  version_revision INTEGER NOT NULL,
  grant_revision INTEGER NOT NULL CHECK(grant_revision >= 0),
  sha256 TEXT NOT NULL,
  etag TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX download_tickets_expiry ON download_tickets(expires_at, token_hash);
