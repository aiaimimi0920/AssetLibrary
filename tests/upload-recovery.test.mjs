import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createResource, fixture } from "./fixture.mjs";
import {
  bytes,
  callWithStorage,
  cancel,
  complete,
  due,
  keyOf,
  put,
  reserve,
  sha256,
  storageOverride,
  tick,
} from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});
const state = async (upload) => (await f.request("GET", `/v1/uploads/${upload.id}`)).body.state;

test("预留审计失败原子回滚授权与幂等记录，恢复后同键只创建一次", async () => {
  const resource = await createResource(f);
  const key = randomUUID();
  const body = { size: bytes.length, sha256: sha256(bytes) };
  const reservePath = `/v1/resources/${resource.id}/uploads`;
  await f.db
    .prepare(
      "CREATE TRIGGER fail_reserve_audit BEFORE INSERT ON upload_events WHEN NEW.state = 'pending' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_RESERVE_FAILURE'); END",
    )
    .run();
  try {
    const result = await f.request("POST", reservePath, body, { key });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "SERVICE_UNAVAILABLE" });
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM uploads WHERE resource_id = ?")
          .bind(resource.id)
          .first()
      ).n,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare(
            "SELECT count(*) AS n FROM mutation_requests WHERE principal = ? AND request_key = ?",
          )
          .bind("user:alice", key)
          .first()
      ).n,
      0,
    );
  } finally {
    await f.db.prepare("DROP TRIGGER fail_reserve_audit").run();
  }
  const first = await f.request("POST", reservePath, body, { key });
  assert.equal(first.status, 201);
  assert.deepEqual((await f.request("POST", reservePath, body, { key })).body, first.body);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM upload_events WHERE upload_id = ?")
        .bind(first.body.id)
        .first()
    ).n,
    1,
  );
});

test("R2 已写入但完成事务失败：保留对象和 pending，原生 scheduled 恢复", async () => {
  const upload = await reserve(f);
  assert.equal((await put(f, upload)).status, 200);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_upload_audit BEFORE INSERT ON upload_events WHEN NEW.state = 'quarantined' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_UPLOAD_AUDIT_FAILURE'); END",
    )
    .run();
  try {
    const result = await complete(f, upload);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "SERVICE_UNAVAILABLE" });
    assert.equal(await state(upload), "pending");
    assert.ok(await f.bucket.head(keyOf(upload)));
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM upload_events WHERE upload_id = ?")
          .bind(upload.id)
          .first()
      ).n,
      1,
    );
  } finally {
    await f.db.prepare("DROP TRIGGER fail_upload_audit").run();
  }
  await due(f, upload);
  await tick(f);
  assert.equal(await state(upload), "quarantined");
  assert.equal((await complete(f, upload)).body.revision, 2);
});

test("取消提交后 R2 删除失败：保留终态，后台重试清理", async () => {
  const upload = await reserve(f);
  await put(f, upload);
  const storage = storageOverride(f, {
    delete: async () => {
      throw new Error("TEST_ONLY_R2_UNAVAILABLE");
    },
  });
  const result = await callWithStorage(f, "DELETE", `/v1/uploads/${upload.id}`, undefined, storage);
  assert.equal(result.status, 503);
  assert.equal(await state(upload), "cancelled");
  assert.ok(await f.bucket.head(keyOf(upload)));
  assert.equal((await complete(f, upload)).status, 410);
  await due(f, upload);
  await tick(f);
  assert.equal(await f.bucket.head(keyOf(upload)), null);
  assert.equal(await state(upload), "cancelled");
});

test("取消与持有旧 HEAD 的完成竞争：不能复活或写出成功审计", async () => {
  const upload = await reserve(f);
  await put(f, upload);
  let observed;
  let release;
  const captured = new Promise((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const storage = storageOverride(f, {
    head: async (key) => {
      const object = await f.bucket.head(key);
      observed();
      await barrier;
      return object;
    },
  });
  const pending = callWithStorage(f, "POST", `/v1/uploads/${upload.id}/complete`, {}, storage);
  try {
    await captured;
    assert.equal((await cancel(f, upload)).status, 200);
  } finally {
    release();
  }
  assert.equal((await pending).status, 410);
  assert.equal(await state(upload), "cancelled");
  assert.equal(await f.bucket.head(keyOf(upload)), null);
  const events = await f.db
    .prepare("SELECT state FROM upload_events WHERE upload_id = ? ORDER BY revision")
    .bind(upload.id)
    .all();
  assert.deepEqual(
    events.results.map((row) => row.state),
    ["pending", "cancelled"],
  );
});

test("取消后的晚到 R2 写入由终态墓碑再次清理", async () => {
  const upload = await reserve(f);
  await cancel(f, upload);
  // 模拟请求进程中断后已经在途的写入落盘；不把此注入称为真实网络竞速。
  await f.bucket.put(keyOf(upload), bytes, { sha256: sha256(bytes) });
  assert.ok(await f.bucket.head(keyOf(upload)));
  await due(f, upload);
  await tick(f);
  assert.equal(await f.bucket.head(keyOf(upload)), null);
  assert.equal(await state(upload), "cancelled");
});

test("资源删除、授权过期、已完成对象缺失或校验元数据异常均关闭状态", async () => {
  const removed = await reserve(f);
  await put(f, removed);
  await complete(f, removed);
  await f.request("DELETE", `/v1/resources/${removed.resourceId}`, { revision: 1 });
  await due(f, removed);
  const expired = await reserve(f);
  await put(f, expired);
  await f.db
    .prepare("UPDATE uploads SET expires_at = 0, reconcile_at = 0 WHERE id = ?")
    .bind(expired.id)
    .run();
  const missing = await reserve(f);
  await put(f, missing);
  await complete(f, missing);
  await f.bucket.delete(keyOf(missing));
  await due(f, missing);
  const invalid = await reserve(f);
  // 自定义元数据不是可信摘要；没有 R2 原生 SHA-256 校验事实时不能完成。
  await f.bucket.put(keyOf(invalid), bytes, { customMetadata: { sha256: invalid.sha256 } });
  await due(f, invalid);
  await tick(f);
  assert.equal(await state(removed), "cancelled");
  assert.equal(await state(expired), "expired");
  assert.equal(await state(missing), "missing");
  assert.equal(await state(invalid), "rejected");
  for (const upload of [removed, expired, missing, invalid])
    assert.equal(await f.bucket.head(keyOf(upload)), null);
});

test("对账每轮最多 25 条，不扫描或删除未登记的其他 R2 对象", async () => {
  const uploads = [];
  for (let i = 0; i < 26; i++) uploads.push(await reserve(f));
  await f.db.batch(
    uploads.map((upload) =>
      f.db
        .prepare("UPDATE uploads SET expires_at = 0, reconcile_at = 0 WHERE id = ?")
        .bind(upload.id),
    ),
  );
  await f.bucket.put("other-owner/keep", bytes);
  await tick(f);
  const first = await Promise.all(uploads.map(state));
  assert.equal(first.filter((value) => value === "expired").length, 25);
  await tick(f);
  assert.ok((await Promise.all(uploads.map(state))).every((value) => value === "expired"));
  assert.ok(await f.bucket.head("other-owner/keep"));
});
