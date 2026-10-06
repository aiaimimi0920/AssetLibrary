import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { appendFile } from "node:fs/promises";
import path from "node:path";
import { artifactRoot } from "../scripts/source-scope.mjs";
import { scheduledWithStorage } from "./inspection-fixture.mjs";
import { storageOverride } from "./upload-fixture.mjs";

const tables = [
  "resources",
  "resource_members",
  "mutation_requests",
  "audit_events",
  "uploads",
  "upload_events",
  "inspections",
  "inspection_events",
  "versions",
  "version_events",
  "publications",
  "publication_events",
  "download_grants",
  "download_grant_events",
  "download_tickets",
];
export async function durableSnapshot(f) {
  const snapshot = {
    schema: (
      await f.db.prepare("SELECT type, name, sql FROM sqlite_schema ORDER BY type, name").all()
    ).results,
  };
  for (const table of tables) {
    const rows = (await f.db.prepare(`SELECT * FROM ${table}`).all()).results;
    snapshot[table] = rows.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  return snapshot;
}
export const inspectionRow = (f, upload) =>
  f.db.prepare("SELECT * FROM inspections WHERE upload_id = ?").bind(upload.id).first();
export async function inspectionStates(f, id) {
  return (
    await f.db
      .prepare("SELECT state FROM inspection_events WHERE inspection_id = ? ORDER BY revision")
      .bind(id)
      .all()
  ).results.map((row) => row.state);
}

// 可选 Windows 运行回执只枚举当前 Node 的 workerd 子进程，不结束或操作其他会话。
async function processCheckpoint(f, phase) {
  const directory = process.env.ASSETLIBRARY_RESTART_EVIDENCE;
  if (!directory) return undefined;
  const relative = path.relative(artifactRoot, path.resolve(directory));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("INVALID_RESTART_EVIDENCE_PATH");
  if (process.platform !== "win32") throw new Error("WINDOWS_RESTART_EVIDENCE_REQUIRED");
  const command = `$rows = @(Get-CimInstance Win32_Process -Filter "Name='workerd.exe' AND ParentProcessId=${process.pid}" | Select-Object ProcessId,ParentProcessId); ConvertTo-Json -InputObject $rows -Compress`;
  const children = JSON.parse(
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
      encoding: "utf8",
      timeout: 10000,
    }),
  );
  await appendFile(
    path.join(directory, `runtime-processes-${process.pid}.jsonl`),
    `${JSON.stringify({ phase, nodePid: process.pid, persist: f.persist, children })}\n`,
    "utf8",
  );
  return children;
}

export async function checkedRestart(f, onStopped) {
  const previous = {
    mf: f.mf,
    db: f.db,
    bucket: f.bucket,
    url: await f.mf.ready,
    persist: f.persist,
  };
  const oldProcesses = await processCheckpoint(f, "before-dispose");
  if (oldProcesses) assert.equal(oldProcesses.length, 1);
  await f.restart(async () => {
    const stopped = await processCheckpoint(f, "after-dispose-before-open");
    if (stopped) {
      assert.deepEqual(stopped, []);
      for (const { ProcessId } of oldProcesses)
        assert.throws(() => process.kill(ProcessId, 0), { code: "ESRCH" });
    }
    await assert.rejects(previous.mf.dispatchFetch("http://localhost/healthz"));
    await assert.rejects(async () => previous.db.prepare("SELECT 1").first());
    await assert.rejects(
      fetch(new URL("/healthz", previous.url), { signal: AbortSignal.timeout(2000) }),
    );
    await onStopped?.();
  });
  assert.notEqual(f.mf, previous.mf);
  assert.notEqual(f.db, previous.db);
  assert.notEqual(f.bucket, previous.bucket);
  assert.equal(f.persist, previous.persist);
  assert.equal(f.env.DB, f.db);
  assert.equal(f.env.QUARANTINE, f.bucket);
  assert.equal((await f.request("GET", "/healthz")).status, 200);
  const opened = await processCheckpoint(f, "after-open");
  if (opened) {
    assert.equal(opened.length, 1);
    assert.ok(
      opened.every((child) => oldProcesses.every((old) => old.ProcessId !== child.ProcessId)),
    );
  }
}

/** 生产调度实际 claim 后在宿主 R2 GET 暂停；关闭旧实例后释放，旧 stub 无法再提交。 */
export async function holdInspection(f) {
  let release;
  let captured;
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const entered = new Promise((resolve) => {
    captured = resolve;
  });
  const storage = storageOverride(f, {
    get: async () => {
      captured();
      await barrier;
      return null;
    },
  });
  const pending = scheduledWithStorage(f, storage).then(
    () => ({ ok: true }),
    (error) => ({ ok: false, error }),
  );
  const timeout = setTimeout(release, 5000);
  try {
    await Promise.race([
      entered,
      pending.then(() => {
        throw new Error("INSPECTION_BARRIER_NOT_ENTERED");
      }),
    ]);
    clearTimeout(timeout);
    return { release, pending };
  } catch (error) {
    release();
    await pending;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export async function closeHeld(held) {
  held.release();
  const outcome = await held.pending;
  assert.equal(outcome.ok, false);
  assert.match(outcome.error.message, /INSPECTION_SCHEDULER_INCOMPLETE/);
}
