-- 新增 MCP 类型，保留既有资源、版本、授权与检查事实；只在同一事务中执行。
PRAGMA defer_foreign_keys = ON;
CREATE TABLE resources_mcp_migration (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN ('art', 'capability', 'application', 'mcp')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK(state IN ('draft', 'deleted')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
INSERT INTO resources_mcp_migration SELECT * FROM resources;
DROP TABLE resources;
ALTER TABLE resources_mcp_migration RENAME TO resources;
CREATE INDEX resources_owner_page ON resources(owner, state, id);
CREATE TABLE inspections_mcp_migration (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id),
  policy TEXT NOT NULL CHECK(policy IN ('art-png-rgba8-v1', 'art-zip-manifest-v1', 'art-zip-clamav-v1',
    'capability-zip-clamav-v1', 'application-zip-clamav-v1', 'loom-art-zip-clamav-v1', 'loom-capability-zip-clamav-v1',
    'capability-zip-format-v1', 'application-zip-format-v1', 'mcp-zip-format-v1', 'loom-art-zip-format-v1', 'loom-capability-zip-format-v1', 'loom-mcp-zip-format-v1')),
  upload_revision INTEGER NOT NULL,
  expected_size INTEGER NOT NULL CHECK(expected_size BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  etag TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('queued', 'running', 'passed', 'rejected', 'invalidated', 'failed')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  attempts INTEGER NOT NULL CHECK(attempts BETWEEN 0 AND 3),
  lease_token TEXT,
  lease_until INTEGER NOT NULL,
  next_attempt_at INTEGER NOT NULL,
  error TEXT,
  result TEXT CHECK(result IS NULL OR (json_valid(result) AND length(result) <= 32768)),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_operation TEXT NOT NULL,
  CHECK(policy <> 'art-png-rgba8-v1' OR expected_size <= 1048576),
  CHECK(state <> 'passed' OR policy NOT IN ('capability-zip-clamav-v1', 'application-zip-clamav-v1',
    'capability-zip-format-v1', 'application-zip-format-v1', 'mcp-zip-format-v1')
    OR (result IS NOT NULL AND COALESCE(json_extract(result, '$.schema') = 'neuro-software-package-v1'
      AND json_extract(result, '$.kind') = CASE WHEN policy IN ('capability-zip-clamav-v1', 'capability-zip-format-v1')
        THEN 'capability' WHEN policy = 'mcp-zip-format-v1' THEN 'mcp' ELSE 'application' END, 0))),
  CHECK(state <> 'passed' OR policy NOT IN ('loom-art-zip-clamav-v1', 'loom-capability-zip-clamav-v1',
    'loom-art-zip-format-v1', 'loom-capability-zip-format-v1', 'loom-mcp-zip-format-v1')
    OR (result IS NOT NULL AND COALESCE(json_extract(result, '$.schema') = 'loom-native-zip-v1'
      AND json_extract(result, '$.kind') = CASE WHEN policy IN ('loom-art-zip-clamav-v1', 'loom-art-zip-format-v1')
        THEN 'art' WHEN policy = 'loom-mcp-zip-format-v1' THEN 'mcp' ELSE 'capability' END, 0))),
  CHECK(state <> 'passed' OR policy NOT IN ('art-zip-clamav-v1', 'capability-zip-clamav-v1', 'application-zip-clamav-v1',
    'loom-art-zip-clamav-v1', 'loom-capability-zip-clamav-v1')
    OR (result IS NOT NULL AND COALESCE(
      json_extract(result, '$.scan.verdict') = 'clean' AND json_extract(result, '$.scan.sha256') = sha256
      AND json_extract(result, '$.scan.size') = expected_size AND json_extract(result, '$.scan.engineVersion') = '1.5.4'
      AND json_extract(result, '$.scan.completedAt') < json_extract(result, '$.scan.expiresAt'), 0))),
  CHECK(state <> 'passed' OR policy NOT IN ('capability-zip-format-v1', 'application-zip-format-v1', 'mcp-zip-format-v1',
    'loom-art-zip-format-v1', 'loom-capability-zip-format-v1', 'loom-mcp-zip-format-v1')
    OR (result IS NOT NULL AND COALESCE(json_extract(result, '$.scanStatus') = 'not_scanned'
      AND json_type(result, '$.scan') IS NULL AND json_extract(result, '$.sha256') = sha256, 0)))
) STRICT;
INSERT INTO inspections_mcp_migration SELECT * FROM inspections;
DROP TABLE inspections;
ALTER TABLE inspections_mcp_migration RENAME TO inspections;
CREATE INDEX inspections_due ON inspections(next_attempt_at, id) WHERE state IN ('queued', 'running');

CREATE TABLE versions_mcp_migration (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
  resource_revision INTEGER NOT NULL CHECK(resource_revision > 0),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN ('art', 'capability', 'application', 'mcp')),
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  upload_revision INTEGER NOT NULL CHECK(upload_revision > 0),
  expected_size INTEGER NOT NULL CHECK(expected_size BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  etag TEXT NOT NULL,
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  inspection_revision INTEGER NOT NULL CHECK(inspection_revision > 0),
  inspection_policy TEXT NOT NULL CHECK(inspection_policy IN ('art-png-rgba8-v1', 'art-zip-manifest-v1', 'art-zip-clamav-v1',
    'capability-zip-clamav-v1', 'application-zip-clamav-v1', 'loom-art-zip-clamav-v1', 'loom-capability-zip-clamav-v1',
    'capability-zip-format-v1', 'application-zip-format-v1', 'mcp-zip-format-v1', 'loom-art-zip-format-v1', 'loom-capability-zip-format-v1', 'loom-mcp-zip-format-v1')),
  state TEXT NOT NULL CHECK(state IN ('pending_review', 'approved', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  reviewer TEXT CHECK(reviewer IS NULL OR length(reviewer) BETWEEN 1 AND 200),
  review_decision TEXT CHECK(review_decision IN ('approved', 'rejected')),
  review_reason TEXT CHECK(review_reason IS NULL OR length(review_reason) BETWEEN 1 AND 500),
  reviewed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_operation TEXT NOT NULL,
  UNIQUE(resource_id, label),
  CHECK((kind = 'art' AND inspection_policy IN ('art-png-rgba8-v1', 'art-zip-manifest-v1', 'art-zip-clamav-v1',
      'loom-art-zip-clamav-v1', 'loom-art-zip-format-v1'))
    OR (kind = 'capability' AND inspection_policy IN ('capability-zip-clamav-v1', 'loom-capability-zip-clamav-v1',
      'capability-zip-format-v1', 'loom-capability-zip-format-v1'))
    OR (kind = 'mcp' AND inspection_policy IN ('mcp-zip-format-v1', 'loom-mcp-zip-format-v1'))
    OR (kind = 'application' AND inspection_policy IN ('application-zip-clamav-v1', 'application-zip-format-v1'))),
  CHECK(inspection_policy <> 'art-png-rgba8-v1' OR expected_size <= 1048576),
  CHECK((reviewer IS NULL AND review_decision IS NULL AND review_reason IS NULL AND reviewed_at IS NULL)
    OR (reviewer IS NOT NULL AND review_decision IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK(state <> 'pending_review' OR reviewer IS NULL),
  CHECK(state <> 'approved' OR (review_decision IS NOT NULL AND review_decision = 'approved')),
  CHECK(state <> 'rejected' OR (review_decision IS NOT NULL AND review_decision = 'rejected'))
) STRICT;
INSERT INTO versions_mcp_migration SELECT * FROM versions;
DROP TABLE versions;
ALTER TABLE versions_mcp_migration RENAME TO versions;
CREATE INDEX versions_resource_page ON versions(resource_id, id);
CREATE INDEX versions_review_page ON versions(state, id);
PRAGMA defer_foreign_keys = OFF;
