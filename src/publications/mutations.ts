import { HttpError, json } from "../http";
import { scanPolicy } from "../scanner/facts";
import { currentSnapshot, loadVersion } from "../versions/records";
import { versionSafety } from "../versions/safety";
import {
  loadPublication,
  type PublicationRow,
  publicationScan,
  publicationSelect,
  publicationView,
} from "./records";

/** 业务事务不判定部署安全证明；生产调用者必须先经过 admission.ts。 */
export async function publishVersion(db: D1Database, id: string, actor: string, revision: number) {
  const version = await loadVersion(db, id);
  if (version.owner !== actor) throw new HttpError(404, "NOT_FOUND");
  if (version.revision !== revision) throw new HttpError(409, "REVISION_CONFLICT");
  if (version.state !== "approved") throw new HttpError(409, "VERSION_NOT_APPROVED");
  if (version.binding_current !== 1) throw new HttpError(409, "VERSION_BINDING_CHANGED");
  const safety = versionSafety(version);
  if (!safety.scanCurrent || !safety.scan) throw new HttpError(409, safety.blocker);
  const publication = crypto.randomUUID();
  const operation = crypto.randomUUID();
  const now = Date.now();
  const results = await db.batch<PublicationRow>([
    db
      .prepare(`INSERT INTO publications
      (id, version_id, version_revision, scan_result, state, revision, created_at, updated_at, last_operation)
      SELECT ?, id, revision, ?, 'published', 1, ?, ?, ? FROM versions
      WHERE id = ? AND revision = ? AND state = 'approved' AND inspection_policy = ?
      AND EXISTS (SELECT 1 FROM resources r WHERE r.id = versions.resource_id AND r.owner = ?)
      AND ${currentSnapshot}
      AND EXISTS (SELECT 1 FROM inspections i WHERE i.id = versions.inspection_id AND i.result = ?)
      AND ? > ? ON CONFLICT(version_id) DO NOTHING`)
      .bind(
        publication,
        version.inspection_result,
        now,
        now,
        operation,
        id,
        revision,
        scanPolicy,
        actor,
        version.inspection_result,
        safety.scan.expiresAt,
        now,
      ),
    db
      .prepare(`INSERT INTO publication_events(operation_id, publication_id, actor, action, revision, created_at)
      SELECT ?, id, ?, 'published', revision, ? FROM publications WHERE last_operation = ?`)
      .bind(operation, actor, now, operation),
    db.prepare(`${publicationSelect} WHERE p.version_id = ?`).bind(id),
  ]);
  const row = results.at(-1)?.results[0];
  if (!row) throw new HttpError(409, "VERSION_BINDING_CHANGED");
  if (row.state !== "published") throw new HttpError(409, "PUBLICATION_STATE_CONFLICT");
  if (row.binding_current !== 1) throw new HttpError(409, "VERSION_BINDING_CHANGED");
  if (!publicationScan(row)) throw new HttpError(409, "CONTENT_SCAN_EXPIRED_OR_INVALIDATED");
  return json(publicationView(row), row.last_operation === operation ? 201 : 200);
}

/** 下架终态及自然重放；成功事件必须与 CAS 同事务，失败不留假审计。 */
export async function unlistPublication(
  db: D1Database,
  id: string,
  actor: string,
  revision: number,
) {
  const operation = crypto.randomUUID();
  const now = Date.now();
  const results = await db.batch<PublicationRow>([
    db
      .prepare(`UPDATE publications SET state = 'unlisted', revision = revision + 1,
      updated_at = ?, last_operation = ? WHERE id = ? AND state = 'published' AND revision = ?
      AND EXISTS (SELECT 1 FROM versions v JOIN resources r ON r.id = v.resource_id
        WHERE v.id = publications.version_id AND r.owner = ?)`)
      .bind(now, operation, id, revision, actor),
    db
      .prepare(`INSERT INTO publication_events(operation_id, publication_id, actor, action, revision, created_at)
      SELECT ?, id, ?, 'unlisted', revision, ? FROM publications WHERE last_operation = ?`)
      .bind(operation, actor, now, operation),
    db.prepare(`${publicationSelect} WHERE p.id = ?`).bind(id),
  ]);
  const row = results.at(-1)?.results[0];
  if (!row || row.owner !== actor) throw new HttpError(404, "NOT_FOUND");
  if (
    row.last_operation !== operation &&
    !(row.state === "unlisted" && row.revision === revision + 1)
  )
    throw new HttpError(409, "REVISION_CONFLICT");
  return json(publicationView(row));
}

export async function ownerPublication(db: D1Database, id: string, actor: string) {
  const row = await loadPublication(db, id);
  if (row.owner !== actor) throw new HttpError(404, "NOT_FOUND");
  return json(publicationView(row));
}
