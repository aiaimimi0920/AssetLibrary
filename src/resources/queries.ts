import { withOptionalSchemas } from "../spaces/optional-schemas";

/** 权限判断和目录读取均使用 D1 primary；不使用复制会话或授权缓存。 */
export function resourceJsonFor(
  hasShowcase = true,
  hasAssetMarket = true,
  r = "r",
  rp = "rp",
  ra = "ra",
) {
  const profile = hasShowcase
    ? `json_object(
      'space', COALESCE(${rp}.space, 'general'),
      'summary', COALESCE(${rp}.summary, ''),
      'detail', COALESCE(${rp}.detail, ''),
      'cover', CASE WHEN ${rp}.cover_key IS NULL THEN NULL ELSE json_object(
        'sha256', ${rp}.cover_sha256,
        'size', ${rp}.cover_size,
        'width', ${rp}.cover_width,
        'height', ${rp}.cover_height,
        'url', '/v1/resources/' || ${r}.id || '/cover'
      ) END
    )`
    : `json_object('space', 'general', 'summary', '', 'detail', '', 'cover', NULL)`;
  const assetAttributes = hasAssetMarket
    ? `json_object(
      'category', COALESCE(${ra}.category, 'general'),
      'style', COALESCE(${ra}.style, 'general'),
      'formats', json(COALESCE(${ra}.formats, '[]')),
      'license', COALESCE(${ra}.license, 'unspecified')
    )`
    : `json_object('category', 'general', 'style', 'general', 'formats', json('[]'), 'license', 'unspecified')`;
  return `json_object(
    'id', ${r}.id, 'owner', ${r}.owner, 'kind', ${r}.kind, 'title', ${r}.title,
    'state', ${r}.state, 'revision', ${r}.revision,
    'createdAt', ${r}.created_at, 'updatedAt', ${r}.updated_at,
    'profile', ${profile},
    'assetAttributes', ${assetAttributes}
  )`;
}

export const resourceJson = resourceJsonFor(true, true, "r", "rp", "ra");

export function resourceJoinsFor(hasShowcase = true, hasAssetMarket = true, r = "r") {
  return [
    hasShowcase ? `LEFT JOIN resource_profiles rp ON rp.resource_id = ${r}.id` : "",
    hasAssetMarket ? `LEFT JOIN resource_asset_attributes ra ON ra.resource_id = ${r}.id` : "",
  ]
    .filter(Boolean)
    .join(" ");
}

export async function getResource(db: D1Database, principal: string, id: string) {
  const row = await withOptionalSchemas(db, (showcase, assetMarket) => {
    const join = resourceJoinsFor(showcase, assetMarket);
    return db
      .prepare(`SELECT ${resourceJsonFor(showcase, assetMarket)} AS body FROM resources r ${join}
      WHERE r.id = ? AND r.state = 'draft' AND
      (r.owner = ? OR EXISTS (SELECT 1 FROM resource_members m
        WHERE m.resource_id = r.id AND m.principal = ?))`)
      .bind(id, principal, principal)
      .first<{ body: string }>();
  });
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
  const rows = await withOptionalSchemas(db, (showcase, assetMarket) => {
    const jsonExpr = resourceJsonFor(showcase, assetMarket);
    const join = resourceJoinsFor(showcase, assetMarket);
    return db
      .prepare(`SELECT r.id, ${jsonExpr} AS body FROM resources r ${join}
      WHERE r.owner = ? AND r.state = 'draft' AND r.id > ?
      UNION
      SELECT r.id, ${jsonExpr} AS body FROM resources r
      JOIN resource_members m ON m.resource_id = r.id ${join}
      WHERE m.principal = ? AND r.state = 'draft' AND r.id > ?
      ORDER BY id LIMIT ?`)
      .bind(principal, after, principal, after, limit + 1)
      .all<{ id: string; body: string }>();
  });
  const page = rows.results.slice(0, limit);
  return {
    items: page.map((row) => JSON.parse(row.body)),
    nextCursor: rows.results.length > limit ? page.at(-1)?.id : null,
  };
}
