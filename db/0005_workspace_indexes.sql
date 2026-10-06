-- 工作列表的 UUID keyset 使用资源前缀索引，不对版本库做全表排序。
CREATE INDEX versions_resource_page ON versions(resource_id, id);
