-- 上传记录先于任何 R2 写入；终态保留，供中断后的补偿与晚到写入对账。
CREATE TABLE uploads (
  id TEXT PRIMARY KEY,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  owner TEXT NOT NULL,
  expected_size INTEGER NOT NULL CHECK(expected_size BETWEEN 1 AND 16777216),
  sha256 TEXT NOT NULL CHECK(length(sha256) = 64),
  state TEXT NOT NULL CHECK(state IN ('pending', 'quarantined', 'cancelled', 'expired', 'missing', 'rejected')),
  revision INTEGER NOT NULL CHECK(revision > 0),
  etag TEXT,
  expires_at INTEGER NOT NULL,
  reconcile_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_operation TEXT NOT NULL
) STRICT;
CREATE INDEX uploads_reconcile ON uploads(reconcile_at, id);
CREATE INDEX uploads_resource ON uploads(resource_id, id);

CREATE TABLE upload_events (
  operation_id TEXT PRIMARY KEY,
  upload_id TEXT NOT NULL REFERENCES uploads(id),
  actor TEXT NOT NULL,
  state TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(upload_id, revision)
) STRICT;
