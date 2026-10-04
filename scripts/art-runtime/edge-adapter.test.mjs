import test from "node:test";
import assert from "node:assert/strict";
import { createEdgeServer } from "./edge-server.mjs";
import { createPublishedBucket, loopbackOrigin } from "./s3-bucket.mjs";

const token = "a".repeat(48);
const digest = "c".repeat(64);
const prefix = `/accounts/${"a".repeat(32)}/storage/kv/namespaces/${"b".repeat(32)}/values/`;

test("storage ports reject remote origins, quarantine and noncanonical keys", async () => {
  assert.equal(loopbackOrigin("http://127.0.0.1:9999"), "http://127.0.0.1:9999");
  for (const url of ["https://example.com", "http://localhost:9999", "http://127.0.0.1",
    "http://secret@127.0.0.1:9999", "http://127.0.0.1:9999/path", "http://127.0.0.1:9999/?x=1"]) {
    assert.throws(() => loopbackOrigin(url));
  }
  const settings = { origin: "http://127.0.0.1:9999", bucket: "assetlibrary-published",
    accessKey: "isolated-scanner", secretKey: token };
  assert.throws(() => createPublishedBucket({ ...settings, bucket: "assetlibrary-quarantine" }));
  const bucket = createPublishedBucket(settings);
  for (const key of ["quarantine/example.zip", `sha256/aa/${digest}`, "../private", `sha256/cc/${digest}?x=1`]) {
    await assert.rejects(bucket.head(key));
  }
  await assert.rejects(bucket.get(`sha256/cc/${digest}`, { range: { offset: -1, length: 1 } }));
});

test("policy is initially empty and only bounded authenticated protocol writes populate it", async (t) => {
  // This fake isolates adapter routing; the integration harness loads real Edge.
  const worker = { fetch: async (request, env) => new Response(await env.POLICY.get(`public:${digest}`) ?? "missing", {
    status: await env.POLICY.get(`public:${digest}`) ? 200 : 404,
    headers: { "x-method": request.method, "x-path": new URL(request.url).pathname },
  }) };
  const server = createEdgeServer({ policyToken: token, ticketSecret: token, bucket: {} }, worker);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, init) => fetch(origin + path, { ...init, signal: AbortSignal.timeout(3000) });
  const policyPath = prefix + encodeURIComponent(`public:${digest}`);
  const headers = { authorization: `Bearer ${token}` };
  const initial = await request("/public/test");
  assert.equal(initial.status, 404); assert.equal(await initial.text(), "missing");
  assert.equal((await request(policyPath, { method: "PUT", body: "untrusted" })).status, 401);
  assert.equal((await request(prefix + "../invalid", { method: "PUT", headers })).status, 405);
  assert.equal((await request(policyPath, { method: "POST", headers })).status, 400);
  assert.equal((await request(policyPath, { method: "PUT", headers, body: "x".repeat(8193) })).status, 413);
  const written = await request(policyPath, { method: "PUT", headers, body: "from-reconcile" });
  assert.equal(written.status, 200); assert.deepEqual(await written.json(), { success: true });
  const publicResponse = await request("/public/test");
  assert.equal(publicResponse.status, 200); assert.equal(await publicResponse.text(), "from-reconcile");
  assert.equal(publicResponse.headers.get("x-path"), "/public/test");
  assert.equal((await request("/public/test?ticket=not-allowed")).status, 400);
  assert.equal((await request(policyPath, { method: "DELETE", headers })).status, 200);
  assert.equal((await request("/public/test")).status, 404);
  assert.equal((await request("/test/policy-state")).status, 401);
  assert.equal((await request("/test/policy-failure", { method: "POST", headers, body: "invalid" })).status, 400);
  assert.equal((await request("/test/policy-failure", { method: "POST", headers, body: "true" })).status, 200);
  assert.equal((await request(policyPath, { method: "PUT", headers, body: "not-applied" })).status, 503);
  const failed = await (await request("/test/policy-state", { headers })).json();
  assert.equal(failed.failures, 1); assert.deepEqual(failed.keys, []);
  assert.equal((await request("/test/policy-failure", { method: "POST", headers, body: "false" })).status, 200);
  assert.equal((await request(policyPath, { method: "PUT", headers, body: "recovered" })).status, 200);
  assert.equal(await (await request("/public/test")).text(), "recovered");
});
