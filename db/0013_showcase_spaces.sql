-- 作品展示元数据（适用空间、简介、详细说明与静态 PNG 封面）及不可变版本快照。
CREATE TABLE IF NOT EXISTS resource_profiles (
  resource_id TEXT PRIMARY KEY REFERENCES resources(id),
  space TEXT NOT NULL CHECK(space IN ('general', 'loom', 'otter', 'framelab')),
  summary TEXT NOT NULL CHECK(length(summary) <= 160),
  detail TEXT NOT NULL CHECK(length(detail) <= 2000),
  cover_key TEXT CHECK(cover_key IS NULL OR length(cover_key) BETWEEN 1 AND 200),
  cover_sha256 TEXT CHECK(cover_sha256 IS NULL OR length(cover_sha256) = 64),
  cover_size INTEGER CHECK(cover_size IS NULL OR cover_size BETWEEN 1 AND 1048576),
  cover_width INTEGER CHECK(cover_width IS NULL OR cover_width BETWEEN 1 AND 2048),
  cover_height INTEGER CHECK(cover_height IS NULL OR cover_height BETWEEN 1 AND 2048),
  CHECK((cover_key IS NULL AND cover_sha256 IS NULL AND cover_size IS NULL AND cover_width IS NULL AND cover_height IS NULL)
    OR (cover_key IS NOT NULL AND cover_sha256 IS NOT NULL AND cover_size IS NOT NULL AND cover_width IS NOT NULL AND cover_height IS NOT NULL))
) STRICT;

CREATE TABLE IF NOT EXISTS version_profiles (
  version_id TEXT PRIMARY KEY REFERENCES versions(id),
  space TEXT NOT NULL CHECK(space IN ('general', 'loom', 'otter', 'framelab')),
  summary TEXT NOT NULL CHECK(length(summary) <= 160),
  detail TEXT NOT NULL CHECK(length(detail) <= 2000),
  cover_key TEXT CHECK(cover_key IS NULL OR length(cover_key) BETWEEN 1 AND 200),
  cover_sha256 TEXT CHECK(cover_sha256 IS NULL OR length(cover_sha256) = 64),
  cover_size INTEGER CHECK(cover_size IS NULL OR cover_size BETWEEN 1 AND 1048576),
  cover_width INTEGER CHECK(cover_width IS NULL OR cover_width BETWEEN 1 AND 2048),
  cover_height INTEGER CHECK(cover_height IS NULL OR cover_height BETWEEN 1 AND 2048),
  CHECK((cover_key IS NULL AND cover_sha256 IS NULL AND cover_size IS NULL AND cover_width IS NULL AND cover_height IS NULL)
    OR (cover_key IS NOT NULL AND cover_sha256 IS NOT NULL AND cover_size IS NOT NULL AND cover_width IS NOT NULL AND cover_height IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS version_profiles_space ON version_profiles(space, version_id);
