import assert from "node:assert/strict";
import test from "node:test";
import { browserModules } from "./web-client-fixture.mjs";

async function interruptedUpload(t) {
  const original = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = original;
  });
  const { api, upload } = await browserModules();
  api.setCredential("synthetic-token");
  const resource = { id: crypto.randomUUID() };
  const file = new File(["bounded test bytes"], "test.zip");
  const rows = new Map();
  const reservations = [];
  const writes = [];
  let failPut = true;
  let loseReservation = false;
  globalThis.fetch = async (path, options) => {
    if (path.endsWith("/uploads")) {
      const body = JSON.parse(options.body);
      const key = options.headers["Idempotency-Key"];
      let row = rows.get(key);
      if (!row) {
        const id = crypto.randomUUID();
        row = {
          ...body,
          id,
          resourceId: resource.id,
          state: "pending",
          contentUrl: `/v1/uploads/${id}/content`,
        };
        rows.set(key, row);
      }
      reservations.push({ key, id: row.id });
      if (loseReservation) {
        loseReservation = false;
        throw new TypeError("Failed to fetch");
      }
      return Response.json(row);
    }
    if (options.method === "PUT") {
      assert.equal(options.body, file);
      const row = [...rows.values()].find((item) => item.contentUrl === path);
      writes.push(row.id);
      if (row.state !== "pending")
        return Response.json({ error: "UPLOAD_CLOSED" }, { status: 410 });
      if (failPut) return Response.json({ error: "TEST_UPLOAD_INTERRUPTED" }, { status: 503 });
    }
    return Response.json({});
  };
  return {
    api,
    upload,
    resource,
    file,
    rows,
    reservations,
    writes,
    attempt: () =>
      upload.uploadPackage(
        resource,
        file,
        "art-zip-manifest-v1",
        new AbortController().signal,
        () => {},
      ),
    allowPut: () => {
      failPut = false;
    },
    loseResponse: () => {
      loseReservation = true;
    },
  };
}

for (const state of ["cancelled", "expired", "rejected", "missing"]) {
  test(`已绑定上传的 ${state} 终态释放旧意图，同文件可申请新 ID`, async (t) => {
    const f = await interruptedUpload(t);
    await assert.rejects(f.attempt(), /503 TEST_UPLOAD_INTERRUPTED/);
    const old = [...f.rows.values()][0];
    old.state = state;
    f.upload.confirmUploadClosed(old);
    f.allowPut();
    const next = await f.attempt();
    assert.notEqual(next.id, old.id);
    assert.notEqual(f.reservations[1].key, f.reservations[0].key);
    assert.deepEqual(f.writes, [old.id, next.id]);
    assert.equal(f.reservations.length, 2);
  });
}

test("pending/quarantined/未知状态及错误 ID/摘要/资源不能解除已知意图", async (t) => {
  const f = await interruptedUpload(t);
  await assert.rejects(f.attempt(), /503/);
  const row = [...f.rows.values()][0];
  const body = { size: row.size, sha256: row.sha256 };
  const operation = f.api.operationKey(`upload:${row.resourceId}`, body);
  for (const view of [
    ...["pending", "quarantined", "future-state", undefined].map((state) => ({ ...row, state })),
    { ...row, state: "expired", id: crypto.randomUUID() },
    { ...row, state: "expired", resourceId: crypto.randomUUID() },
    { ...row, state: "expired", size: row.size + 1 },
    { ...row, state: "expired", sha256: "a".repeat(64) },
  ]) {
    f.upload.confirmUploadClosed(view);
    assert.deepEqual(f.api.operationKey(`upload:${row.resourceId}`, body), operation);
  }
  f.api.resolveOperation(`upload:${row.resourceId}`, body);
  assert.deepEqual(f.api.operationKey(`upload:${row.resourceId}`, body), operation);
  await assert.rejects(f.attempt(), /503/);
  assert.deepEqual(f.reservations[1], f.reservations[0]);
});

test("历史终态与新 pending 同页重复确认，不误释放新上传的未知写入键", async (t) => {
  const f = await interruptedUpload(t);
  await assert.rejects(f.attempt(), /503/);
  const old = [...f.rows.values()][0];
  old.state = "expired";
  f.upload.confirmUploadClosed(old);
  await assert.rejects(f.attempt(), /503/);
  const current = [...f.rows.values()][1];
  for (const row of [old, current, old]) f.upload.confirmUploadClosed(row);
  await assert.rejects(f.attempt(), /503/);
  assert.deepEqual(f.reservations[2], f.reservations[1]);
  assert.notEqual(f.reservations[1].key, f.reservations[0].key);
  f.allowPut();
  assert.equal((await f.attempt()).id, current.id);
});

test("预约响应丢失仍保留未绑定键，终态列表不能猜测释放；显式重试才能绑定", async (t) => {
  const f = await interruptedUpload(t);
  f.loseResponse();
  await assert.rejects(f.attempt(), /Failed to fetch/);
  const row = [...f.rows.values()][0];
  row.state = "expired";
  f.upload.confirmUploadClosed(row);
  await assert.rejects(f.attempt(), /410 UPLOAD_CLOSED/);
  assert.deepEqual(f.reservations[1], f.reservations[0]);
  f.upload.confirmUploadClosed(row);
  f.allowPut();
  assert.notEqual((await f.attempt()).id, row.id);
});

test("旧 operation 在完成或身份切换后不能绑定/释放同摘要的新意图", async () => {
  const { api } = await browserModules();
  const body = { size: 1, sha256: "a".repeat(64) };
  const scope = "upload:resource";
  api.setCredential("first");
  const old = api.operationKey(scope, body);
  api.bindOperation(old, "old-id");
  api.completeOperation(old);
  const next = api.operationKey(scope, body);
  api.bindOperation(old, "late-id");
  api.resolveOperation(scope, body, "late-id");
  api.completeOperation(old);
  assert.deepEqual(api.operationKey(scope, body), next);
  api.setCredential("second");
  const switched = api.operationKey(scope, body);
  api.bindOperation(next, "old-identity-id");
  api.completeOperation(next);
  api.resolveOperation(scope, body, "old-id");
  assert.deepEqual(api.operationKey(scope, body), switched);
  api.bindOperation(switched, "current-id");
  api.bindOperation(switched, "different-id");
  api.resolveOperation(scope, body, "different-id");
  assert.deepEqual(api.operationKey(scope, body), switched);
  api.resolveOperation(scope, body, "current-id");
  assert.notEqual(api.operationKey(scope, body).key, switched.key);
});
