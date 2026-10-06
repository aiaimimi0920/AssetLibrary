import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createResource, fixture } from "./fixture.mjs";
import { bytes, cancel, complete, keyOf, put, reserve, sha256 } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});

test("R2 原生闭环：授权、流式上传、读回摘要、完成、取消", async () => {
  const upload = await reserve(f);
  assert.equal(upload.state, "pending");
  assert.ok(upload.expiresAt > Date.now());
  assert.equal((await complete(f, upload)).body.error, "UPLOAD_NOT_STORED");
  assert.equal((await put(f, upload)).status, 200);
  const stored = await f.bucket.get(keyOf(upload));
  assert.equal(stored.size, bytes.length);
  assert.equal(sha256(new Uint8Array(await stored.arrayBuffer())), upload.sha256);
  assert.equal(Buffer.from(stored.checksums.sha256).toString("hex"), upload.sha256);
  const completed = await complete(f, upload);
  assert.equal(completed.status, 200);
  assert.equal(completed.body.state, "quarantined");
  assert.equal(completed.body.revision, 2);
  assert.equal((await f.request("GET", `/v1/uploads/${upload.id}/download`)).status, 404);
  assert.equal(
    (await f.request("POST", `/v1/resources/${upload.resourceId}/publish`, {})).status,
    404,
  );
  assert.equal((await cancel(f, upload)).body.state, "cancelled");
  assert.equal((await cancel(f, upload)).body.revision, 3);
  assert.equal(await f.bucket.head(keyOf(upload)), null);
  assert.equal((await put(f, upload)).status, 410);
  assert.equal((await complete(f, upload)).status, 410);
  const events = await f.db
    .prepare("SELECT state FROM upload_events WHERE upload_id = ? ORDER BY revision")
    .bind(upload.id)
    .all();
  assert.deepEqual(
    events.results.map((row) => row.state),
    ["pending", "quarantined", "cancelled"],
  );
});

test("上传和隔离管理仅归 owner；读成员、伪造身份与过期授权拒绝", async () => {
  const upload = await reserve(f);
  await f.request("PUT", `/v1/resources/${upload.resourceId}/members/user:bob`, { revision: 1 });
  for (const principal of ["user:bob", "user:eve"]) {
    assert.equal(
      (await f.request("GET", `/v1/uploads/${upload.id}`, undefined, { principal })).status,
      404,
    );
    assert.equal((await put(f, upload, bytes, { principal })).status, 404);
    assert.equal(
      (await f.request("DELETE", `/v1/uploads/${upload.id}`, undefined, { principal })).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          "POST",
          `/v1/resources/${upload.resourceId}/uploads`,
          { size: bytes.length, sha256: sha256(bytes) },
          { principal },
        )
      ).status,
      404,
    );
  }
  assert.equal((await put(f, upload, bytes, { token: "invalid" })).status, 401);
  await f.db
    .prepare("UPDATE uploads SET expires_at = ? WHERE id = ?")
    .bind(Date.now() - 1, upload.id)
    .run();
  assert.equal((await put(f, upload)).status, 410);
  assert.equal(await f.bucket.head(keyOf(upload)), null);
  assert.equal((await f.request("GET", `/v1/uploads/${upload.id}`)).body.state, "expired");
});

test("输入、实际大小与原生 checksum 校验失败不会产生可用对象", async () => {
  const resource = await createResource(f);
  for (const body of [
    { size: 0, sha256: sha256(bytes) },
    { size: 16777217, sha256: sha256(bytes) },
    { size: 1.5, sha256: sha256(bytes) },
    { size: bytes.length, sha256: "bad" },
    { size: bytes.length, sha256: sha256(bytes), objectKey: "outside/key" },
  ])
    assert.equal(
      (await f.request("POST", `/v1/resources/${resource.id}/uploads`, body)).status,
      400,
    );
  const upload = await reserve(f);
  assert.equal((await put(f, upload, bytes.slice(1))).status, 400);
  assert.equal(
    (await put(f, upload, bytes, { headers: { "content-type": "text/plain" } })).status,
    415,
  );
  const corrupt = new Uint8Array(bytes);
  corrupt[0] ^= 1;
  assert.equal((await put(f, upload, corrupt)).status, 503);
  assert.equal(await f.bucket.head(keyOf(upload)), null);
  assert.equal((await complete(f, upload)).status, 409);
  assert.equal((await put(f, upload)).status, 200);
  assert.equal((await complete(f, upload)).body.state, "quarantined");
});

test("并发预留、PUT、完成幂等，不覆盖唯一对象或重复审计", async () => {
  const resource = await createResource(f);
  const key = randomUUID();
  const body = { size: bytes.length, sha256: sha256(bytes) };
  const reservations = await Promise.all(
    Array.from({ length: 4 }, () =>
      f.request("POST", `/v1/resources/${resource.id}/uploads`, body, { key }),
    ),
  );
  assert.ok(reservations.every((r) => r.status === 201 && r.body.id === reservations[0].body.id));
  assert.equal(
    (await f.request("POST", `/v1/resources/${resource.id}/uploads`, { ...body, size: 1 }, { key }))
      .status,
    409,
  );
  const upload = reservations[0].body;
  const writes = await Promise.all(Array.from({ length: 4 }, () => put(f, upload)));
  assert.ok(
    writes.every((r) => r.status === 200),
    JSON.stringify(writes),
  );
  const etag = (await f.bucket.head(keyOf(upload))).etag;
  const finishes = await Promise.all(Array.from({ length: 4 }, () => complete(f, upload)));
  assert.ok(finishes.every((r) => r.status === 200 && r.body.revision === 2));
  const otherBytes = new Uint8Array(bytes);
  otherBytes[0] ^= 1;
  assert.equal((await put(f, upload, otherBytes)).status, 200);
  assert.equal((await f.bucket.head(keyOf(upload))).etag, etag);
  const stored = await f.bucket.get(keyOf(upload));
  assert.equal(sha256(new Uint8Array(await stored.arrayBuffer())), upload.sha256);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM upload_events WHERE upload_id = ?")
        .bind(upload.id)
        .first()
    ).n,
    2,
  );
});
