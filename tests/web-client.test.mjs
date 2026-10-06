import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function client() {
  const source = await readFile(new URL("../src/web/api.client.js", import.meta.url), "utf8");
  return import(
    `data:text/javascript;base64,${Buffer.from(`${source}\n// ${crypto.randomUUID()}`).toString("base64")}`
  );
}

test("浏览器 API 同源无存储，切换身份和停止请求阻止旧响应污染", async () => {
  const original = globalThis.fetch;
  const api = await client();
  try {
    assert.equal(api.connected(), false);
    await assert.rejects(api.api("/v1/me"), /IDENTITY_REQUIRED/);
    api.setCredential("old-synthetic-token");
    await assert.rejects(api.api("https://other.test/v1/me"), /INVALID_API_PATH/);
    await assert.rejects(api.api("/v1/../../admin"), /INVALID_API_PATH/);
    let release;
    let options;
    globalThis.fetch = async (_url, input) => {
      options = input;
      return new Promise((resolve) => {
        release = resolve;
      });
    };
    const old = api.api("/v1/me");
    assert.equal(options.headers.Authorization, "Bearer old-synthetic-token");
    assert.equal(options.credentials, "omit");
    api.setCredential("new-synthetic-token");
    assert.equal(options.signal.aborted, true);
    release(Response.json({ principal: "old-principal" }));
    await assert.rejects(old, { name: "AbortError" });
    const next = api.api("/v1/me");
    assert.equal(options.headers.Authorization, "Bearer new-synthetic-token");
    api.stopRequests();
    release(Response.json({ principal: "new-principal" }));
    await assert.rejects(next, { name: "AbortError" });
    const cancelled = new AbortController();
    cancelled.abort();
    const pending = api.api("/v1/me", { signal: cancelled.signal });
    assert.equal(options.signal.aborted, true);
    release(Response.json({}));
    await assert.rejects(pending, { name: "AbortError" });
    api.setCredential("");
    assert.equal(api.connected(), false);
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});

test("未知写入保留有界幂等键，成功或身份切换才释放，不自动重放请求", async () => {
  const api = await client();
  api.setCredential("synthetic");
  const first = api.operationKey("create", { title: "a" });
  assert.deepEqual(api.operationKey("create", { title: "a" }), first);
  assert.notEqual(api.operationKey("create", { title: "b" }).key, first.key);
  api.completeOperation(first);
  assert.notEqual(api.operationKey("create", { title: "a" }).key, first.key);
  const upload = api.operationKey("upload:resource", { size: 1, sha256: "a" });
  api.bindOperation(upload, "upload-id");
  api.resolveOperation("upload:resource", { size: 1, sha256: "a" }, "upload-id");
  assert.notEqual(api.operationKey("upload:resource", { size: 1, sha256: "a" }).key, upload.key);
  const beforeSwitch = api.operationKey("create", { title: "a" });
  api.setCredential("other");
  assert.notEqual(api.operationKey("create", { title: "a" }).key, beforeSwitch.key);
  const oldest = api.operationKey("bounded", {});
  for (let index = 0; index < 30; index++) api.operationKey(`key:${index}`, {});
  assert.throws(() => api.operationKey("overflow", {}), /PENDING_OPERATION_LIMIT/);
  assert.deepEqual(api.operationKey("bounded", {}), oldest);
});
