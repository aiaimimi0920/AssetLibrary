-- 待办队列按状态和 UUID keyset 读取，避免全版本库排序；不改变历史事实。
CREATE INDEX versions_review_page ON versions(state, id);
