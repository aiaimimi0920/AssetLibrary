-- P1 只有私有草稿与目录读取授权；没有发布资格、账号密码或下载权限。
CREATE TABLE resources (
  id TEXT PRIMARY KEY,
  owner TEXT NOT NULL CHECK(length(owner) BETWEEN 1 AND 200),
  kind TEXT NOT NULL CHECK(kind IN ('art', 'capability', 'application')),
  title TEXT NOT NULL CHECK(length(title) BETWEEN 1 AND 200),
  state TEXT NOT NULL CHECK(state IN ('draft', 'deleted')),
  revision INTEGER NOT NULL CHECK(revision BETWEEN 1 AND 2147483647),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;
CREATE INDEX resources_owner_page ON resources(owner, state, id);

CREATE TABLE resource_members (
  resource_id TEXT NOT NULL REFERENCES resources(id),
  principal TEXT NOT NULL CHECK(length(principal) BETWEEN 1 AND 200),
  PRIMARY KEY(resource_id, principal)
) STRICT;
CREATE INDEX members_principal_page ON resource_members(principal, resource_id);

-- 幂等键按已验证主体隔离。operation_id 只由服务生成，不信任客户端。
CREATE TABLE mutation_requests (
  principal TEXT NOT NULL,
  request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 8 AND 128),
  fingerprint TEXT NOT NULL CHECK(length(fingerprint) = 64),
  operation_id TEXT NOT NULL UNIQUE,
  status INTEGER NOT NULL CHECK(status IN (200, 201, 404, 409)),
  response TEXT NOT NULL DEFAULT '{}' CHECK(json_valid(response)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(principal, request_key)
) STRICT;

CREATE TABLE audit_events (
  operation_id TEXT PRIMARY KEY REFERENCES mutation_requests(operation_id),
  principal TEXT NOT NULL,
  resource_id TEXT NOT NULL REFERENCES resources(id),
  action TEXT NOT NULL,
  revision INTEGER NOT NULL,
  created_at TEXT NOT NULL
) STRICT;
CREATE UNIQUE INDEX audit_resource ON audit_events(resource_id, revision);
