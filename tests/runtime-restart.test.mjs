import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { createResource, fixture } from "./fixture.mjs";
import { dueInspection, prepared, read, scheduledWithStorage } from "./inspection-fixture.mjs";
import {
  checkedRestart,
  closeHeld,
  durableSnapshot,
  holdInspection,
  inspectionRow,
  inspectionStates,
} from "./runtime-restart-fixture.mjs";
import {
  callWithStorage,
  complete,
  due,
  keyOf,
  put,
  reserve,
  sha256,
  storageOverride,
  tick,
} from "./upload-fixture.mjs";

const state = async (f, upload) => (await f.request("GET", `/v1/uploads/${upload.id}`)).body.state;
async function objectBytes(f, upload) {
  return Buffer.from(await (await f.bucket.get(keyOf(upload))).arrayBuffer());
}

test("完整重开保留 R2/pending、失败事务和幂等回执，实际 cron 恢复且不复活取消状态", async () => {
  const f = await fixture();
  try {
    const bytes = packageBytes();
    const resource = await createResource(f);
    const pathname = `/v1/resources/${resource.id}/uploads`;
    const key = randomUUID();
    const body = { size: bytes.length, sha256: sha256(bytes) };
    const reservation = await f.request("POST", pathname, body, { key });
    assert.equal(reservation.status, 201);
    const upload = reservation.body;
    assert.equal((await put(f, upload, bytes)).status, 200);
    await f.db
      .prepare(
        "CREATE TRIGGER restart_upload_failure BEFORE INSERT ON upload_events WHEN NEW.state = 'quarantined' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_RESTART_UPLOAD_FAILURE'); END",
      )
      .run();
    assert.equal((await complete(f, upload)).status, 503);
    assert.equal(await state(f, upload), "pending");
    const cancelled = await reserve(f, bytes);
    assert.equal((await put(f, cancelled, bytes)).status, 200);
    const brokenDelete = storageOverride(f, {
      delete: async () => {
        throw new Error("TEST_ONLY_RESTART_DELETE_FAILURE");
      },
    });
    assert.equal(
      (await callWithStorage(f, "DELETE", `/v1/uploads/${cancelled.id}`, undefined, brokenDelete))
        .status,
      503,
    );
    assert.equal(await state(f, cancelled), "cancelled");
    const before = await durableSnapshot(f);
    const etag = (await f.bucket.head(keyOf(upload))).etag;
    await checkedRestart(f);
    assert.deepEqual(await durableSnapshot(f), before);
    assert.deepEqual(await objectBytes(f, upload), bytes);
    assert.deepEqual(await objectBytes(f, cancelled), bytes);
    assert.equal((await f.bucket.head(keyOf(upload))).etag, etag);
    assert.deepEqual(
      await f.request("POST", pathname, body, { key }).then((r) => r.body),
      reservation.body,
    );
    await f.db.prepare("DROP TRIGGER restart_upload_failure").run();
    await due(f, upload);
    await due(f, cancelled);
    await tick(f);
    assert.equal(await state(f, upload), "quarantined");
    assert.equal(await state(f, cancelled), "cancelled");
    assert.equal(await f.bucket.head(keyOf(cancelled)), null);
    assert.equal((await complete(f, cancelled)).status, 410);
    assert.deepEqual(await objectBytes(f, upload), bytes);
    const recovered = await durableSnapshot(f);
    assert.deepEqual(
      recovered.upload_events
        .filter((e) => e.upload_id === upload.id)
        .map((e) => e.state)
        .sort(),
      ["pending", "quarantined"],
    );
    assert.deepEqual(
      recovered.upload_events
        .filter((e) => e.upload_id === cancelled.id)
        .map((e) => e.state)
        .sort(),
      ["cancelled", "pending"],
    );
    await checkedRestart(f);
    assert.deepEqual(await durableSnapshot(f), recovered);
    await tick(f);
    assert.equal((await complete(f, upload)).body.revision, 2);
    assert.equal((await f.request("POST", pathname, body, { key })).body.id, upload.id);
    const replayed = await durableSnapshot(f);
    // 显式 complete 会延后下次对账时间；除此之外不得改变业务、回执或成功审计。
    const stableUploads = (rows) => rows.map(({ reconcile_at: _time, ...row }) => row);
    assert.deepEqual(stableUploads(replayed.uploads), stableUploads(recovered.uploads));
    assert.deepEqual({ ...replayed, uploads: recovered.uploads }, recovered);
    assert.deepEqual(await objectBytes(f, upload), bytes);
  } finally {
    await f.dispose();
  }
});

test("实际领取的 running 租约重开后保持，过期后第二次格式检查成功且旧执行者不能写回", async () => {
  const f = await fixture();
  let held;
  try {
    const bytes = packageBytes();
    const upload = await prepared(f, bytes);
    assert.equal((await startPackage(f, upload)).status, 201);
    held = await holdInspection(f);
    const running = await inspectionRow(f, upload);
    assert.equal(running.state, "running");
    assert.equal(running.attempts, 1);
    assert.ok(running.lease_token);
    assert.ok(running.lease_until > Date.now());
    const before = await durableSnapshot(f);
    await checkedRestart(f, () => closeHeld(held));
    assert.deepEqual(await durableSnapshot(f), before);
    await tick(f);
    assert.deepEqual(await inspectionRow(f, upload), running);
    // 仅推进已有租约/到期时间，不改 state、attempts、token、结果或审计。
    await dueInspection(f, upload);
    await tick(f);
    const passed = (await read(f, upload)).body;
    assert.equal(passed.state, "passed");
    assert.equal(passed.attempts, 2);
    assert.equal(passed.policy, "art-zip-manifest-v1");
    assert.equal(passed.publicationEligible, false);
    assert.deepEqual(await inspectionStates(f, passed.id), [
      "queued",
      "running",
      "running",
      "passed",
    ]);
    assert.deepEqual(await objectBytes(f, upload), bytes);
    const recovered = await durableSnapshot(f);
    await checkedRestart(f);
    assert.deepEqual(await durableSnapshot(f), recovered);
    await tick(f);
    assert.deepEqual((await startPackage(f, upload)).body, passed);
    assert.deepEqual(await durableSnapshot(f), recovered);
  } finally {
    held?.release();
    await held?.pending;
    await f.dispose();
  }
});

test("第三次实际执行中断后重开仍保留三次消费，租约回收只记 failed 且重复申请不重置", async () => {
  const f = await fixture();
  let held;
  try {
    const upload = await prepared(f, packageBytes());
    assert.equal((await startPackage(f, upload)).status, 201);
    const brokenRead = storageOverride(f, {
      get: async () => {
        throw new Error("TEST_ONLY_RESTART_READ_FAILURE");
      },
    });
    for (let attempt = 1; attempt <= 2; attempt++) {
      await dueInspection(f, upload);
      await scheduledWithStorage(f, brokenRead);
      assert.equal((await read(f, upload)).body.attempts, attempt);
      assert.equal((await read(f, upload)).body.state, "queued");
    }
    await dueInspection(f, upload);
    held = await holdInspection(f);
    const running = await inspectionRow(f, upload);
    assert.equal(running.state, "running");
    assert.equal(running.attempts, 3);
    const before = await durableSnapshot(f);
    await checkedRestart(f, () => closeHeld(held));
    assert.deepEqual(await durableSnapshot(f), before);
    await tick(f);
    assert.deepEqual(await inspectionRow(f, upload), running);
    await dueInspection(f, upload);
    await tick(f);
    const failed = (await read(f, upload)).body;
    assert.equal(failed.state, "failed");
    assert.equal(failed.attempts, 3);
    assert.equal(failed.error, "INSPECTION_RETRY_EXHAUSTED");
    assert.equal(failed.result, null);
    assert.deepEqual(await inspectionStates(f, failed.id), [
      "queued",
      "running",
      "queued",
      "running",
      "queued",
      "running",
      "failed",
    ]);
    const recovered = await durableSnapshot(f);
    await checkedRestart(f);
    await tick(f);
    assert.deepEqual((await startPackage(f, upload)).body, failed);
    assert.deepEqual(await durableSnapshot(f), recovered);
  } finally {
    held?.release();
    await held?.pending;
    await f.dispose();
  }
});
