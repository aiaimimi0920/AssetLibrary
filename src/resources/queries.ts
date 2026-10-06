/** 权限判断和目录读取均使用 D1 primary；不使用复制会话或授权缓存。 */
export const resourceJson = `json_object(
  'id', id, 'owner', owner, 'kind', kind, 'title', title,
  'state', state, 'revision', revision, 'createdAt', created_at, 'updatedAt', updated_at
)`;

export async function getResource(db: D1Database, principal: string, id: string) {
  const row = await db
    .prepare(`SELECT ${resourceJson} AS body FROM resources r
    WHERE r.id = ? AND r.state = 'draft' AND
    (r.owner = ? OR EXISTS (SELECT 1 FROM resource_members m
      WHERE m.resource_id = r.id AND m.principal = ?))`)
    .bind(id, principal, principal)
    .first<{ body: string }>();
  return row ? JSON.parse(row.body) : null;
}

/** owner 查询指定主体的目录权限和同一快照 revision，不泄露其他成员。 */
export async function getMember(db: D1Database, owner: string, id: string, member: string) {
  const row = await db
    .prepare(`SELECT r.revision, EXISTS (SELECT 1 FROM resource_members m
      WHERE m.resource_id = r.id AND m.principal = ?) AS active
      FROM resources r WHERE r.id = ? AND r.owner = ? AND r.state = 'draft'`)
    .bind(member, id, owner)
    .first<{ revision: number; active: number }>();
  return row
    ? {
        resourceId: id,
        principal: member,
        active: row.active === 1,
        resourceRevision: row.revision,
      }
    : null;
}

export async function listResources(
  db: D1Database,
  principal: string,
  after: string,
  limit: number,
) {
  const rows = await db
    .prepare(`SELECT id, ${resourceJson} AS body FROM resources
    WHERE owner = ? AND state = 'draft' AND id > ?
    UNION
    SELECT r.id, ${resourceJson} AS body FROM resources r
    JOIN resource_members m ON m.resource_id = r.id
    WHERE m.principal = ? AND r.state = 'draft' AND r.id > ?
    ORDER BY id LIMIT ?`)
    .bind(principal, after, principal, after, limit + 1)
    .all<{ id: string; body: string }>();
  const page = rows.results.slice(0, limit);
  return {
    items: page.map((row) => JSON.parse(row.body)),
    nextCursor: rows.results.length > limit ? page.at(-1)?.id : null,
  };
}
