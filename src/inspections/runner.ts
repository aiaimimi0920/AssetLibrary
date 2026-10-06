import type { UploadEnv } from "../uploads/records";
import { inspectObject } from "./object";
import { ContentRejected } from "./png";
import { bindingCurrent, loadInspection } from "./records";
import { claimInspection, finishInspection } from "./tasks";

export async function runInspection(env: UploadEnv, id: string) {
  const claim = await claimInspection(env.DB, id);
  if (!claim) return;
  const row = await loadInspection(env.DB, claim.uploadId);
  try {
    if (!bindingCurrent(row)) {
      await finishInspection(env.DB, row, claim.token, "invalidated", "INSPECTION_BINDING_CHANGED");
      return;
    }
    const result = await inspectObject(env, row);
    await finishInspection(env.DB, row, claim.token, "passed", null, result);
  } catch (error) {
    if (error instanceof ContentRejected)
      await finishInspection(env.DB, row, claim.token, "rejected", error.code);
    else
      await finishInspection(
        env.DB,
        row,
        claim.token,
        row.attempts >= 3 ? "failed" : "queued",
        "INSPECTION_TEMPORARILY_UNAVAILABLE",
      );
  }
}

/** 每轮最多三项顺序检查；持久租约恢复中断，不启动脱离 owner 的后台任务。 */
export async function inspectDue(env: UploadEnv) {
  const due = await env.DB.prepare(`SELECT id FROM inspections WHERE state IN ('queued', 'running')
    AND next_attempt_at <= ? ORDER BY next_attempt_at, id LIMIT 3`)
    .bind(Date.now())
    .all<{ id: string }>();
  let failed = 0;
  for (const { id } of due.results) {
    try {
      await runInspection(env, id);
    } catch {
      failed++;
    }
  }
  return { processed: due.results.length, failed };
}
