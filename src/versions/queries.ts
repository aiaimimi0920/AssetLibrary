import { HttpError, json } from "../http";
import { pageInput } from "../page";
import { type ReviewConfig, reviewers } from "./policy";
import { type VersionRow, versionSelect, versionView } from "./records";

/** owner 工作列表与独立审核队列分别授权，不能复用成员读权限。 */
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

/** 每页重新检查部署名单；仅返回他人的活动待办，不将游标当作授权。 */
export async function listReviews(
  db: D1Database,
  config: ReviewConfig,
  principal: string,
  url: URL,
) {
  if (!reviewers(config).includes(principal)) throw new HttpError(404, "NOT_FOUND");
  const { after, limit } = pageInput(url);
  const rows = await db
    .prepare(`${versionSelect} WHERE versions.state = 'pending_review'
      AND versions.id > ? AND r.owner <> ? AND r.state = 'draft'
      ORDER BY versions.id LIMIT ?`)
    .bind(after, principal, limit + 1)
    .all<VersionRow>();
  return json({
    items: rows.results.slice(0, limit).map((row) => ({ ...versionView(row), owner: row.owner })),
    nextCursor: rows.results.length > limit ? rows.results[limit - 1]?.id : null,
  });
}
