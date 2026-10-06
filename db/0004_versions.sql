-- 不可变版本快照和独立审核；本阶段没有 published 状态。
CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  label TEXT NOT NULL CHECK(length(label) BETWEEN 1 AND 64),
  resource_revision INTEGER NOT NULL CHECK(resource_revision > 0),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind = 'art'),
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  upload_revision INTEGER NOT NULL CHECK(upload_revision > 0),
  expected_size INTEGER NOT NULL CHECK(expected_size BETWEEN 1 AND 8388608),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  etag TEXT NOT NULL,
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  inspection_revision INTEGER NOT NULL CHECK(inspection_revision > 0),
  inspection_policy TEXT NOT NULL CHECK(inspection_policy IN ('art-png-rgba8-v1', 'art-zip-manifest-v1', 'art-zip-clamav-v1')),
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
  CHECK(inspection_policy <> 'art-png-rgba8-v1' OR expected_size <= 1048576),
  CHECK((reviewer IS NULL AND review_decision IS NULL AND review_reason IS NULL AND reviewed_at IS NULL)
    OR (reviewer IS NOT NULL AND review_decision IS NOT NULL AND review_reason IS NOT NULL AND reviewed_at IS NOT NULL)),
  CHECK(state <> 'pending_review' OR reviewer IS NULL),
  CHECK(state <> 'approved' OR (review_decision IS NOT NULL AND review_decision = 'approved')),
  CHECK(state <> 'rejected' OR (review_decision IS NOT NULL AND review_decision = 'rejected'))
) STRICT;

CREATE TABLE version_events (
  operation_id TEXT PRIMARY KEY,
  version_id TEXT NOT NULL REFERENCES versions(id),
  actor TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('created', 'approved', 'rejected', 'withdrawn')),
  revision INTEGER NOT NULL,
  reason TEXT,
  created_at INTEGER NOT NULL,
  UNIQUE(version_id, revision)
) STRICT;
