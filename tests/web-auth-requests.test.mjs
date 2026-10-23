import assert from "node:assert/strict";
import test from "node:test";
import { browserModules } from "./web-client-fixture.mjs";

test("并发退出只发一次带 CSRF 的请求，失败可由用户重试", async (t) => {
  const original = globalThis.fetch;
  const { api } = await browserModules();
  t.after(() => {
    api.stopRequests();
    globalThis.fetch = original;
  });
  api.setSession("a".repeat(64));
  let release;
  const requests = [];
  globalThis.fetch = (path, options) => {
    requests.push({ path, options });
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const first = api.logoutSession();
  const second = api.logoutSession();
  assert.equal(first, second);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].options.headers["X-AssetLibrary-CSRF"], "a".repeat(64));
  assert.ok(requests[0].options.signal instanceof AbortSignal);
  release(new Response(null, { status: 503 }));
  await assert.rejects(first, /SESSION_REQUEST_FAILED/);
  assert.equal(api.connected(), true);
  const next = api.logoutSession();
  assert.equal(requests.length, 2);
  release(Response.json({ logoutUrl: "https://account.test/oauth2/v1/logout" }));
  assert.equal(await next, "https://account.test/oauth2/v1/logout");
  assert.equal(api.connected(), false);
});

test("session/退出受停止和身份代际保护，不接受迟到响应", async (t) => {
  const original = globalThis.fetch;
  const { api } = await browserModules();
  t.after(() => {
    api.stopRequests();
    globalThis.fetch = original;
  });
  let release;
  let signal;
  globalThis.fetch = (_path, options) => {
    signal = options.signal;
    return new Promise((resolve) => {
      release = resolve;
    });
  };
  const pending = api.readSession();
  api.stopRequests();
  assert.equal(signal.aborted, true);
  release(Response.json({ principal: "old" }));
  await assert.rejects(pending, { name: "AbortError" });
  api.setSession("a".repeat(64));
  const logout = api.logoutSession();
  api.setSession("b".repeat(64));
  release(Response.json({ logoutUrl: "https://account.test/oauth2/v1/logout" }));
  await assert.rejects(logout, { name: "AbortError" });
  assert.equal(api.connected(), true);
});
