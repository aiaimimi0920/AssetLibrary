import { HttpError, json } from "../http";
import { pageInput } from "../page";
import { type UploadRow, uploadView } from "./records";

/** 隔离上传列表仅 owner 可读；目录成员不因此取得对象管理权限。 */
export async function listUploads(db: D1Database, resourceId: string, principal: string, url: URL) {
  const { after, limit } = pageInput(url);
  const owner = await db
    .prepare("SELECT id FROM resources WHERE id = ? AND owner = ? AND state = 'draft'")
    .bind(resourceId, principal)
    .first();
  if (!owner) throw new HttpError(404, "NOT_FOUND");
  const rows = await db
    .prepare(`SELECT u.* FROM uploads u JOIN resources r ON r.id = u.resource_id
    WHERE u.resource_id = ? AND u.owner = ? AND r.owner = ? AND r.state = 'draft' AND u.id > ?
    ORDER BY u.id LIMIT ?`)
    .bind(resourceId, principal, principal, after, limit + 1)
    .all<UploadRow>();
  return json({
    items: rows.results.slice(0, limit).map(uploadView),
    nextCursor: rows.results.length > limit ? rows.results[limit - 1]?.id : null,
  });
}
