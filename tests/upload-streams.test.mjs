import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fixture } from "./fixture.mjs";
import { bytes, complete, keyOf, put, reserve, sha256 } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ streamFaults: true });
});
after(async () => {
  await f?.dispose();
});

test("16 MiB 边界通过本地 Worker 流式写入并读回摘要", async () => {
  const data = new Uint8Array(16 * 1024 * 1024).fill(42);
  const upload = await reserve(f, data);
  assert.equal((await put(f, upload, data)).status, 200);
  assert.equal((await complete(f, upload)).body.state, "quarantined");
  const object = await f.bucket.get(keyOf(upload));
  assert.equal(object.size, data.length);
  assert.equal(sha256(new Uint8Array(await object.arrayBuffer())), upload.sha256);
});

test("声明正确长度但实际流过短、过长或中断均失败，原授权可以重新上传", async () => {
  for (const mode of ["short", "long", "interrupt", "late-interrupt"]) {
    const upload = await reserve(f);
    const result = await put(f, upload, bytes, {
      headers: { "x-test-stream-fault": mode },
    });
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "SERVICE_UNAVAILABLE" });
    const stored = await f.bucket.head(keyOf(upload));
    assert.equal(
      stored,
      null,
      `${mode}: size=${stored?.size}, checksum=${stored?.checksums.sha256 ? Buffer.from(stored.checksums.sha256).toString("hex") : "none"}`,
    );
    assert.equal((await complete(f, upload)).body.error, "UPLOAD_NOT_STORED");
    assert.equal((await put(f, upload)).status, 200);
    assert.equal((await complete(f, upload)).body.state, "quarantined");
  }
});

test("单字节对象同样等待 EOF，末字节不会丢失", async () => {
  const data = Uint8Array.of(42);
  const upload = await reserve(f, data);
  assert.equal((await put(f, upload, data)).status, 200);
  assert.equal((await complete(f, upload)).body.state, "quarantined");
  const object = await f.bucket.get(keyOf(upload));
  assert.equal(object.size, 1);
  assert.equal(sha256(new Uint8Array(await object.arrayBuffer())), upload.sha256);
});

test("读成员与其他主体无法完成上传，重复完成也重新验证身份", async () => {
  const upload = await reserve(f);
  await put(f, upload);
  await f.request("PUT", `/v1/resources/${upload.resourceId}/members/user:bob`, { revision: 1 });
  for (const principal of ["user:bob", "user:eve"]) {
    const result = await f.request("POST", `/v1/uploads/${upload.id}/complete`, {}, { principal });
    assert.equal(result.status, 404);
  }
  assert.equal((await complete(f, upload)).body.revision, 2);
  assert.equal(
    (await f.request("POST", `/v1/uploads/${upload.id}/complete`, {}, { token: "invalid" })).status,
    401,
  );
});
