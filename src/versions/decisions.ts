import { HttpError, json } from "../http";
import {
  currentSnapshot,
  type VersionRow,
  versionEvent,
  versionSelect,
  versionView,
} from "./records";

export type Decision = "approved" | "rejected" | "withdrawn";

/** 每项最多一个审核决定，撤回不抹掉历史审核；CAS 与成功审计原子提交。 */
export async function decideVersion(
  db: D1Database,
  id: string,
  actor: string,
  revision: number,
  decision: Decision,
  reason: string | null,
) {
  const operation = crypto.randomUUID();
  const now = Date.now();
  const withdrawal = decision === "withdrawn";
  const assignment = withdrawal
    ? ""
    : "reviewer = ?, review_decision = ?, review_reason = ?, reviewed_at = ?,";
  const reviewArgs = withdrawal ? [] : [actor, decision, reason, now];
  const stateGate = withdrawal
    ? "state IN ('pending_review', 'approved', 'rejected')"
    : "state = 'pending_review'";
  const ownerGate = `EXISTS (SELECT 1 FROM resources r WHERE r.id = versions.resource_id AND r.owner ${withdrawal ? "=" : "<>"} ?)`;
  const results = await db.batch<VersionRow>([
    db
      .prepare(`UPDATE versions SET ${assignment} state = ?, revision = revision + 1,
      updated_at = ?, last_operation = ? WHERE id = ? AND revision = ? AND ${stateGate}
      AND ${ownerGate} ${decision === "approved" ? `AND ${currentSnapshot}` : ""}`)
      .bind(...reviewArgs, decision, now, operation, id, revision, actor),
    versionEvent(db, id, operation, actor, decision, reason, now),
    db.prepare(`${versionSelect} WHERE versions.id = ?`).bind(id),
  ]);
  const row = results.at(-1)?.results[0];
  if (!row) throw new HttpError(404, "NOT_FOUND");
  const replay =
    row.state === decision &&
    row.revision === revision + 1 &&
    (withdrawal ? row.owner === actor : row.reviewer === actor && row.review_reason === reason);
  if (row.last_operation !== operation && !replay) {
    if (row.revision !== revision) throw new HttpError(409, "REVISION_CONFLICT");
    if (decision === "approved" && row.binding_current !== 1)
      throw new HttpError(409, "VERSION_BINDING_CHANGED");
    throw new HttpError(409, "VERSION_STATE_CONFLICT");
  }
  return json(versionView(row));
}
