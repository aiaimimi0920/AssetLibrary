import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { hypotheticalPublication, ticketFor } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { dueInspection, prepared, read, start } from "./inspection-fixture.mjs";
import { captured, faultDatabase, hostSchedule, OperationLog } from "./operations-fixture.mjs";
import { due, keyOf, put, reserve, storageOverride } from "./upload-fixture.mjs";

let f;
const log = new OperationLog();
before(async () => {
  f = await fixture({ reviewers: '["user:reviewer"]', runtimeLog: log });
});
after(async () => f?.dispose());

function stages(events) {
  const result = events.filter((event) => event.event === "scheduled.stage");
  assert.deepEqual(
    result.map((event) => event.stage),
    ["uploads", "inspections", "tickets"],
  );
  assert.equal(new Set(result.map((event) => event.runId)).size, 1);
  const complete = events.find((event) => event.event === "scheduled.complete");
  assert.equal(complete.runId, result[0].runId);
  return { result, complete };
}

// 票据需要真实 D1/R2 关系；此准备明确是合成扫描和假设准入，不声称生产发布。
async function expiredTicket() {
  const prepared = await hypotheticalPublication(f);
  const ticket = await ticketFor(f, prepared.publication);
  await f.db
    .prepare("UPDATE download_tickets SET expires_at = 0 WHERE publication_id = ?")
    .bind(prepared.publication.id)
    .run();
  return { ...prepared, ticket };
}
const tickets = async (publication) =>
  (
    await f.db
      .prepare("SELECT count(*) AS n FROM download_tickets WHERE publication_id = ?")
      .bind(publication.id)
      .first()
  ).n;

test("实际 Worker 定时触发有三阶段和汇总事件，空批次计数明确且可关联", async () => {
  const response = await f.mf.dispatchFetch("http://localhost/cdn-cgi/local/scheduled");
  assert.equal(response.status, 200);
  const complete = await log.wait((event) => event.event === "scheduled.complete");
  const { result } = stages(log.events.filter((event) => event.runId === complete.runId));
  assert.equal(complete.status, "completed");
  assert.equal(complete.failedStages, 0);
  for (const event of result) {
    assert.equal(event.status, "completed");
    assert.equal(event.counts.processed, 0);
    assert.equal(event.counts.dispatchErrors, 0);
  }
});

test("三阶段同时失败仍各尝试一次，汇总不漏失败且保留首个脱敏错误", async () => {
  const db = faultDatabase(f.db, () => true, "PRIVATE_ALL_FAILURE_DO_NOT_LOG");
  const failure = await captured(async () => {
    await assert.rejects(hostSchedule(f, { DB: db }), { message: "UPLOAD_RECONCILE_INCOMPLETE" });
  });
  const { result, complete } = stages(failure.events);
  assert.equal(complete.failedStages, 3);
  assert.equal(complete.status, "incomplete");
  assert.ok(result.every((event) => event.status === "incomplete"));
  assert.ok(result.every((event) => Object.keys(event.counts).length === 0));
  assert.ok(!JSON.stringify(failure.events).includes("PRIVATE_"));
});

test("部分上传已经提交后阶段中断不伪造计数，后续恢复不重复成功审计", async () => {
  const first = await reserve(f);
  const second = await reserve(f);
  await put(f, first);
  await put(f, second);
  await f.db.prepare("UPDATE uploads SET reconcile_at = ? WHERE id = ?").bind(-2, first.id).run();
  await f.db.prepare("UPDATE uploads SET reconcile_at = ? WHERE id = ?").bind(-1, second.id).run();
  let schedules = 0;
  const db = faultDatabase(
    f.db,
    (sql) => sql.startsWith("UPDATE uploads SET reconcile_at") && ++schedules === 2,
    "PRIVATE_RETRY_WRITE_DO_NOT_LOG",
  );
  const storage = storageOverride(f, {
    head: async (key) => {
      if (key === keyOf(second)) throw new Error("PRIVATE_HEAD_DO_NOT_LOG");
      return f.bucket.head(key);
    },
  });
  const failure = await captured(async () => {
    await assert.rejects(hostSchedule(f, { DB: db, QUARANTINE: storage }), {
      message: "UPLOAD_RECONCILE_INCOMPLETE",
    });
  });
  assert.deepEqual(stages(failure.events).result[0].counts, {});
  const state = async (upload) =>
    (await f.db.prepare("SELECT state FROM uploads WHERE id = ?").bind(upload.id).first()).state;
  assert.equal(await state(first), "quarantined");
  assert.equal(await state(second), "pending");
  const recovered = await captured(() => hostSchedule(f));
  assert.equal(stages(recovered.events).complete.status, "completed");
  assert.equal(await state(second), "quarantined");
  for (const upload of [first, second]) {
    const n = await f.db
      .prepare(
        "SELECT count(*) AS n FROM upload_events WHERE upload_id = ? AND state = 'quarantined'",
      )
      .bind(upload.id)
      .first();
    assert.equal(n.n, 1);
    assert.ok(await f.bucket.head(keyOf(upload)));
  }
});

test("两个重叠定时执行保持检查租约和成功审计唯一，不因观测重置 attempts", async () => {
  const upload = await prepared(f);
  await start(f, upload);
  const overlap = await captured(() => Promise.all([hostSchedule(f), hostSchedule(f)]));
  const runs = overlap.events.filter((event) => event.event === "scheduled.complete");
  assert.equal(runs.length, 2);
  assert.equal(new Set(runs.map((event) => event.runId)).size, 2);
  for (const run of runs) {
    assert.equal(run.status, "completed");
    stages(overlap.events.filter((event) => event.runId === run.runId));
  }
  const inspected = (await read(f, upload)).body;
  assert.equal(inspected.state, "passed");
  assert.equal(inspected.attempts, 1);
  const n = await f.db
    .prepare(
      "SELECT count(*) AS n FROM inspection_events WHERE inspection_id = ? AND state = 'passed'",
    )
    .bind(inspected.id)
    .first();
  assert.equal(n.n, 1);
});

test("检查阶段完成仅表示有界调度：拒绝、重排队及三次耗尽不冒充扫描通过", async () => {
  const bad = await prepared(f, new TextEncoder().encode("not a PNG"));
  await start(f, bad);
  const rejected = stages((await captured(() => hostSchedule(f))).events);
  assert.equal(rejected.result[1].status, "completed");
  assert.equal(rejected.result[1].scope, "bounded_batch");
  assert.equal(rejected.result[1].counts.dispatchErrors, 0);
  assert.equal((await read(f, bad)).body.state, "rejected");
  const upload = await prepared(f);
  await start(f, upload);
  const storage = storageOverride(f, {
    get: async () => {
      throw new Error("PRIVATE_TRANSIENT_GET_DO_NOT_LOG");
    },
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dueInspection(f, upload);
    const batch = stages((await captured(() => hostSchedule(f, { QUARANTINE: storage }))).events);
    assert.equal(batch.result[1].status, "completed");
    assert.equal(batch.result[1].counts.dispatchErrors, 0);
    const state = (await read(f, upload)).body;
    assert.equal(state.attempts, attempt);
    assert.equal(state.state, attempt === 3 ? "failed" : "queued");
  }
  await captured(() => hostSchedule(f));
  assert.equal((await read(f, upload)).body.attempts, 3);
});

test("上传阶段硬失败不饿死检查和票据清理，恢复后原事实可继续对账", async () => {
  const bundle = await expiredTicket();
  const upload = await prepared(f);
  await start(f, upload);
  const db = faultDatabase(
    f.db,
    (sql) => sql.includes("FROM uploads WHERE reconcile_at"),
    "PRIVATE_UPLOAD_FAILURE_DO_NOT_LOG",
  );
  const failure = await captured(async () => {
    await assert.rejects(hostSchedule(f, { DB: db }), { message: "UPLOAD_RECONCILE_INCOMPLETE" });
  });
  const { result, complete } = stages(failure.events);
  assert.deepEqual(
    result.map((event) => event.status),
    ["incomplete", "completed", "completed"],
  );
  assert.deepEqual(result[0].counts, {});
  assert.equal(result[1].counts.processed, 1);
  assert.equal(result[2].counts.processed, 1);
  assert.equal(complete.failedStages, 1);
  assert.equal((await read(f, upload)).body.state, "passed");
  assert.equal(await tickets(bundle.publication), 0);
  assert.ok(!JSON.stringify(failure.events).includes("PRIVATE_"));
  await due(f, upload);
  const recovered = await captured(() => hostSchedule(f));
  assert.equal(stages(recovered.events).complete.status, "completed");
  assert.equal((await read(f, upload)).body.attempts, 1);
});

test("检查查询故障仍清理过期票据，恢复后排队任务只执行一次", async () => {
  const bundle = await expiredTicket();
  const upload = await prepared(f);
  await start(f, upload);
  const db = faultDatabase(
    f.db,
    (sql) => sql.includes("FROM inspections WHERE state"),
    "PRIVATE_INSPECTION_FAILURE_DO_NOT_LOG",
  );
  const failure = await captured(async () => {
    await assert.rejects(hostSchedule(f, { DB: db }), {
      message: "INSPECTION_SCHEDULER_INCOMPLETE",
    });
  });
  const { result, complete } = stages(failure.events);
  assert.equal(result[1].status, "incomplete");
  assert.deepEqual(result[1].counts, {});
  assert.equal(result[2].counts.processed, 1);
  assert.equal(complete.failedStages, 1);
  assert.equal((await read(f, upload)).body.attempts, 0);
  assert.equal((await read(f, upload)).body.state, "queued");
  assert.equal(await tickets(bundle.publication), 0);
  const recovered = await captured(() => hostSchedule(f));
  assert.equal(stages(recovered.events).complete.status, "completed");
  const inspected = (await read(f, upload)).body;
  assert.equal(inspected.state, "passed");
  assert.equal(inspected.attempts, 1);
});

test("真实 SQLite 删除 ABORT 不伪造清理成功，修复后只回收票据且日志 sink 不影响恢复", async () => {
  const bundle = await expiredTicket();
  const before = await f.db
    .prepare("SELECT * FROM publications WHERE id = ?")
    .bind(bundle.publication.id)
    .first();
  const objectBefore = await f.bucket.head(
    `quarantine/${bundle.upload.resourceId}/${bundle.upload.id}`,
  );
  await f.db
    .prepare(
      "CREATE TRIGGER test_ticket_delete_failure BEFORE DELETE ON download_tickets BEGIN SELECT RAISE(ABORT, 'PRIVATE_DELETE_FAILURE_DO_NOT_LOG'); END",
    )
    .run();
  try {
    const failure = await captured(async () => {
      await assert.rejects(hostSchedule(f), { message: "TICKET_CLEANUP_INCOMPLETE" });
    });
    const { result, complete } = stages(failure.events);
    assert.equal(result[2].status, "incomplete");
    assert.deepEqual(result[2].counts, {});
    assert.equal(complete.status, "incomplete");
    assert.equal(await tickets(bundle.publication), 1);
    assert.ok(!JSON.stringify(failure.events).includes("PRIVATE_"));
  } finally {
    await f.db.prepare("DROP TRIGGER test_ticket_delete_failure").run();
  }
  await captured(() => hostSchedule(f), { brokenLogger: true });
  assert.equal(await tickets(bundle.publication), 0);
  assert.deepEqual(
    await f.db
      .prepare("SELECT * FROM publications WHERE id = ?")
      .bind(bundle.publication.id)
      .first(),
    before,
  );
  assert.equal(
    (await f.bucket.head(`quarantine/${bundle.upload.resourceId}/${bundle.upload.id}`)).etag,
    objectBefore.etag,
  );
});

test("单次票据清理最多 100 条，保留有效票据、发布与对象；下一次完成剩余项", async () => {
  const bundle = await expiredTicket();
  const valid = await ticketFor(f, bundle.publication);
  const source = await f.db
    .prepare("SELECT token_hash FROM download_tickets WHERE publication_id = ? AND expires_at = 0")
    .bind(bundle.publication.id)
    .first();
  const inserts = Array.from({ length: 104 }, () =>
    f.db
      .prepare(`INSERT INTO download_tickets
    SELECT ?, principal, publication_id, publication_revision, version_revision, grant_revision,
    sha256, etag, expires_at, created_at FROM download_tickets WHERE token_hash = ?`)
      .bind(createHash("sha256").update(randomUUID()).digest("hex"), source.token_hash),
  );
  for (let i = 0; i < inserts.length; i += 50) await f.db.batch(inserts.slice(i, i + 50));
  assert.equal(await tickets(bundle.publication), 106);
  const first = stages((await captured(() => hostSchedule(f))).events);
  assert.equal(first.result[2].counts.processed, 100);
  assert.equal(first.complete.status, "completed");
  assert.equal(await tickets(bundle.publication), 6);
  const second = stages((await captured(() => hostSchedule(f))).events);
  assert.equal(second.result[2].counts.processed, 5);
  assert.equal(await tickets(bundle.publication), 1);
  const core = await import("./distribution-fixture.mjs").then((module) => module.coreModules());
  assert.equal(
    (await core.authorizeTicket(f.db, bundle.publication.id, "user:alice", valid.ticket)).id,
    bundle.publication.id,
  );
});
