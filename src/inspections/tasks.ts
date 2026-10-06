import {
  currentBinding,
  type InspectionRow,
  type InspectionState,
  inspectionEvent,
} from "./records";

/** 两分钟租约与唯一 token 隔离旧执行者；每项最多三次实际执行，不无限重试。 */
export async function claimInspection(db: D1Database, id: string) {
  const operation = crypto.randomUUID();
  const now = Date.now();
  const executable = `${currentBinding} AND attempts < 3`;
  await db.batch([
    db
      .prepare(`UPDATE inspections SET state = CASE WHEN NOT ${currentBinding} THEN 'invalidated'
      WHEN attempts >= 3 THEN 'failed' ELSE 'running' END,
      attempts = CASE WHEN ${executable} THEN attempts + 1 ELSE attempts END, revision = revision + 1,
      lease_token = CASE WHEN ${executable} THEN ? ELSE NULL END,
      lease_until = CASE WHEN ${executable} THEN ? ELSE 0 END,
      next_attempt_at = CASE WHEN ${executable} THEN ? ELSE 0 END,
      error = CASE WHEN NOT ${currentBinding} THEN 'INSPECTION_BINDING_CHANGED'
      WHEN attempts >= 3 THEN 'INSPECTION_RETRY_EXHAUSTED' ELSE NULL END,
      result = NULL, updated_at = ?, last_operation = ?
      WHERE id = ? AND state IN ('queued', 'running') AND next_attempt_at <= ?`)
      .bind(operation, now + 120000, now + 120000, now, operation, id, now),
    inspectionEvent(db, operation, id, "system:inspector", now),
  ]);
  const row = await db
    .prepare("SELECT upload_id, state, lease_token FROM inspections WHERE id = ?")
    .bind(id)
    .first<{ upload_id: string; state: InspectionState; lease_token: string | null }>();
  return row?.state === "running" && row.lease_token === operation
    ? { uploadId: row.upload_id, token: operation }
    : null;
}

/** 结果、身份快照和审计同批提交；取消/删除之后只能写 invalidated，不能写 passed。 */
export async function finishInspection(
  db: D1Database,
  row: InspectionRow,
  token: string,
  state: InspectionState,
  error: string | null,
  result: unknown = null,
) {
  const operation = crypto.randomUUID();
  const now = Date.now();
  await db.batch([
    db
      .prepare(`UPDATE inspections SET
      state = CASE WHEN ${currentBinding} THEN ? ELSE 'invalidated' END,
      error = CASE WHEN ${currentBinding} THEN ? ELSE 'INSPECTION_BINDING_CHANGED' END,
      result = CASE WHEN ${currentBinding} AND ? = 'passed' THEN ? ELSE NULL END,
      next_attempt_at = CASE WHEN ? = 'queued' THEN ? ELSE 0 END,
      lease_token = NULL, lease_until = 0, revision = revision + 1, updated_at = ?, last_operation = ?
      WHERE id = ? AND state = 'running' AND lease_token = ? AND lease_until > ?`)
      .bind(
        state,
        error,
        state,
        result === null ? null : JSON.stringify(result),
        state,
        now + 60000,
        now,
        operation,
        row.id,
        token,
        now,
      ),
    inspectionEvent(db, operation, row.id, "system:inspector", now),
  ]);
}
