-- 内容检查绑定不可变上传事实；不把检查通过等同于审核或发布。
CREATE TABLE inspections (
  id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL UNIQUE REFERENCES uploads(id),
  policy TEXT NOT NULL CHECK(policy IN ('art-png-rgba8-v1', 'art-zip-manifest-v1', 'art-zip-clamav-v1',
    'capability-zip-clamav-v1', 'application-zip-clamav-v1')),
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
  CHECK(state <> 'passed' OR policy NOT IN ('capability-zip-clamav-v1', 'application-zip-clamav-v1')
    OR (result IS NOT NULL AND COALESCE(json_extract(result, '$.schema') = 'neuro-software-package-v1'
      AND json_extract(result, '$.kind') = CASE policy WHEN 'capability-zip-clamav-v1' THEN 'capability'
      WHEN 'application-zip-clamav-v1' THEN 'application' END, 0))),
  CHECK(state <> 'passed' OR policy NOT IN ('art-zip-clamav-v1', 'capability-zip-clamav-v1', 'application-zip-clamav-v1')
    OR (result IS NOT NULL AND COALESCE(
    json_extract(result, '$.scan.verdict') = 'clean' AND json_extract(result, '$.scan.sha256') = sha256
    AND json_extract(result, '$.scan.size') = expected_size AND json_extract(result, '$.scan.engineVersion') = '1.5.4'
    AND json_extract(result, '$.scan.completedAt') < json_extract(result, '$.scan.expiresAt'), 0)))
) STRICT;
CREATE INDEX inspections_due ON inspections(next_attempt_at, id) WHERE state IN ('queued', 'running');

CREATE TABLE inspection_events (
  operation_id TEXT PRIMARY KEY,
  inspection_id TEXT NOT NULL REFERENCES inspections(id),
  actor TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(inspection_id, revision)
) STRICT;
