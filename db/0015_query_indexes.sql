-- 公开目录、应用内容空间、素材细分筛选与求购广场复合查询索引（纯新增索引，零表重建）。
CREATE INDEX IF NOT EXISTS versions_resource_state
  ON versions(resource_id, state, id);

CREATE INDEX IF NOT EXISTS versions_kind_state
  ON versions(kind, state, id);

CREATE INDEX IF NOT EXISTS version_asset_attributes_filter
  ON version_asset_attributes(category, style, license, version_id);

CREATE INDEX IF NOT EXISTS asset_requests_space_public
  ON asset_requests(state, space, id);

CREATE INDEX IF NOT EXISTS asset_requests_style_public
  ON asset_requests(state, style, id);

CREATE INDEX IF NOT EXISTS asset_requests_license_public
  ON asset_requests(state, license, id);
