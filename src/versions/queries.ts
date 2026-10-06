import { HttpError, json } from "../http";
import { pageInput } from "../page";
import { type VersionRow, versionSelect, versionView } from "./records";

/** owner 的工作列表不是公开目录或 reviewer 搜索；审核仍使用已知版本 ID。 */
export async function listVersions(
  db: D1Database,
  resourceId: string,
  principal: string,
  url: URL,
) {
  const { after, limit } = pageInput(url);
  const owner = await db
    .prepare("SELECT id FROM resources WHERE id = ? AND owner = ? AND state = 'draft'")
    .bind(resourceId, principal)
    .first();
  if (!owner) throw new HttpError(404, "NOT_FOUND");
  const rows = await db
    .prepare(`${versionSelect} WHERE versions.resource_id = ? AND r.owner = ?
    AND r.state = 'draft' AND versions.id > ? ORDER BY versions.id LIMIT ?`)
    .bind(resourceId, principal, after, limit + 1)
    .all<VersionRow>();
  return json({
    items: rows.results.slice(0, limit).map(versionView),
    nextCursor: rows.results.length > limit ? rows.results[limit - 1]?.id : null,
  });
}
