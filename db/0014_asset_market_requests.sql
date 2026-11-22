-- 素材细分属性与求购广场保数据增量表；不重建既有表，不含在线支付或资金托管字段。
CREATE TABLE IF NOT EXISTS resource_asset_attributes (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id),
  category TEXT NOT NULL DEFAULT 'general'
    CHECK (category IN ('general', 'models', 'images', 'materials', 'audio', 'effects', 'templates')),
  style TEXT NOT NULL DEFAULT 'general'
    CHECK (style IN ('general', 'pixel', 'lowpoly', 'realistic', 'stylized', 'handdrawn')),
  formats TEXT NOT NULL DEFAULT '[]'
    CHECK (length(formats) BETWEEN 2 AND 64 AND json_valid(formats)),
  license TEXT NOT NULL DEFAULT 'unspecified'
    CHECK (license IN ('unspecified', 'commercial', 'personal', 'open_source'))
) STRICT;

CREATE TABLE IF NOT EXISTS version_asset_attributes (
  version_id TEXT PRIMARY KEY REFERENCES versions(id),
  category TEXT NOT NULL
    CHECK (category IN ('general', 'models', 'images', 'materials', 'audio', 'effects', 'templates')),
  style TEXT NOT NULL
    CHECK (style IN ('general', 'pixel', 'lowpoly', 'realistic', 'stylized', 'handdrawn')),
  formats TEXT NOT NULL
    CHECK (length(formats) BETWEEN 2 AND 64 AND json_valid(formats)),
  license TEXT NOT NULL
    CHECK (license IN ('unspecified', 'commercial', 'personal', 'open_source'))
) STRICT;

CREATE INDEX IF NOT EXISTS version_asset_attributes_category
  ON version_asset_attributes(category, license, version_id);

CREATE TABLE IF NOT EXISTS asset_requests (
  id TEXT PRIMARY KEY,
  requester TEXT NOT NULL CHECK (length(requester) BETWEEN 1 AND 200),
  title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  category TEXT NOT NULL
    CHECK (category IN ('models', 'images', 'materials', 'audio', 'effects', 'templates')),
  style TEXT NOT NULL
    CHECK (style IN ('general', 'pixel', 'lowpoly', 'realistic', 'stylized', 'handdrawn')),
  space TEXT NOT NULL
    CHECK (space IN ('general', 'loom', 'otter', 'framelab')),
  formats TEXT NOT NULL
    CHECK (length(formats) BETWEEN 4 AND 64 AND json_valid(formats)),
  license TEXT NOT NULL
    CHECK (license IN ('commercial', 'personal', 'open_source')),
  period_days INTEGER NOT NULL CHECK (period_days BETWEEN 1 AND 180),
  budget_note TEXT NOT NULL DEFAULT '' CHECK (length(budget_note) <= 80),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 1500),
  delivery TEXT NOT NULL CHECK (length(delivery) BETWEEN 1 AND 400),
  state TEXT NOT NULL CHECK (state IN ('open', 'closed')),
  revision INTEGER NOT NULL CHECK (revision BETWEEN 1 AND 2147483647),
  response_count INTEGER NOT NULL DEFAULT 0 CHECK (response_count BETWEEN 0 AND 2147483647),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS asset_requests_public
  ON asset_requests(state, category, id);
CREATE INDEX IF NOT EXISTS asset_requests_requester
  ON asset_requests(requester, id);

CREATE TABLE IF NOT EXISTS asset_request_responses (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES asset_requests(id),
  responder TEXT NOT NULL CHECK (length(responder) BETWEEN 1 AND 200),
  publication_id TEXT REFERENCES publications(id),
  message TEXT NOT NULL CHECK (length(message) BETWEEN 1 AND 1000),
  created_at INTEGER NOT NULL,
  UNIQUE(request_id, responder)
) STRICT;

CREATE INDEX IF NOT EXISTS asset_request_responses_request
  ON asset_request_responses(request_id, id);

CREATE TABLE IF NOT EXISTS asset_request_events (
  operation_id TEXT PRIMARY KEY REFERENCES mutation_requests(operation_id),
  request_id TEXT NOT NULL REFERENCES asset_requests(id),
  actor TEXT NOT NULL CHECK (length(actor) BETWEEN 1 AND 200),
  action TEXT NOT NULL CHECK (action IN ('created', 'responded', 'closed')),
  revision INTEGER NOT NULL,
  created_at INTEGER NOT NULL
) STRICT;
