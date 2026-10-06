import {
  isTerminal,
  loadUpload,
  objectKey,
  scheduleCheck,
  transition,
  type UploadEnv,
  type UploadRow,
} from "./records";

export function objectMatches(
  row: Pick<UploadRow, "expected_size" | "sha256" | "etag">,
  object: R2Object,
): boolean {
  const checksum = object.checksums.sha256;
  if (!checksum || object.size !== row.expected_size) return false;
  const hex = [...new Uint8Array(checksum)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return hex === row.sha256 && (row.etag === null || row.etag === object.etag);
}

export async function cleanupTerminal(env: UploadEnv, row: UploadRow) {
  if (!isTerminal(row)) return;
  // 只清理 D1 中预先登记的唯一隔离键；保留墓碑以捕获中断后的晚到 PUT。
  await env.QUARANTINE.delete(objectKey(row));
  await scheduleCheck(env.DB, row, Date.now() + 3600000);
}

export async function reconcileOne(
  env: UploadEnv,
  initial: UploadRow,
  actor: string,
): Promise<UploadRow> {
  let row = await loadUpload(env.DB, initial.id);
  if (!isTerminal(row) && row.resource_state !== "draft")
    row = await transition(env, row, "cancelled", actor);
  if (row.state === "pending" && row.expires_at <= Date.now())
    row = await transition(env, row, "expired", actor);
  if (isTerminal(row)) {
    await cleanupTerminal(env, row);
    return row;
  }
  const object = await env.QUARANTINE.head(objectKey(row));
  if (object && !objectMatches(row, object)) {
    row = await transition(env, row, "rejected", actor);
  } else if (!object && row.state === "quarantined") {
    row = await transition(env, row, "missing", actor);
  } else if (object && row.state === "pending") {
    row = await transition(env, row, "quarantined", actor, object.etag);
  }
  // CAS 失败可能意味着 cancel 已提交；绝不根据之前的 HEAD 恢复取消状态。
  if (isTerminal(row)) await cleanupTerminal(env, row);
  else
    await scheduleCheck(
      env.DB,
      row,
      row.state === "pending" ? Math.min(row.expires_at, Date.now() + 60000) : Date.now() + 3600000,
    );
  return row;
}

/** 每轮最多 25 个有索引的到期记录，顺序处理；失败仍到期但短暂退避防止饿死后续任务。 */
export async function reconcileDue(env: UploadEnv) {
  const due = await env.DB.prepare(`SELECT id FROM uploads WHERE reconcile_at <= ?
    ORDER BY reconcile_at, id LIMIT 25`)
    .bind(Date.now())
    .all<{ id: string }>();
  let completed = 0;
  let failed = 0;
  for (const { id } of due.results) {
    const row = await loadUpload(env.DB, id);
    try {
      await reconcileOne(env, row, "system:reconciler");
      completed++;
    } catch {
      failed++;
      await scheduleCheck(env.DB, row, Date.now() + 60000);
    }
  }
  return { processed: due.results.length, completed, failed };
}
