import assert from "node:assert/strict";
import test from "node:test";
import { browserModules } from "./web-client-fixture.mjs";

const path = "/v1/publications/11111111-1111-4111-8111-111111111111/content";
const ticket = "a".repeat(64);

test("受限分段请求保留认证、同源和取消保护，票据不进入 URL", async () => {
  const { api } = await browserModules();
  const original = globalThis.fetch;
  api.setCredential("synthetic-range");
  try {
    globalThis.fetch = async (url, options) => {
      assert.equal(url, path);
      assert.equal(options.headers.Authorization, "Bearer synthetic-range");
      assert.equal(options.headers["X-Download-Ticket"], ticket);
      assert.equal(options.headers.Range, "bytes=262144-524287");
      assert.equal(options.headers["If-Range"], '"object-etag"');
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      return new Response("segment", { status: 206 });
    };
    assert.equal(
      await api.withResponse(
        path,
        {
          ticket,
          range: "bytes=262144-524287",
          ifRange: '"object-etag"',
        },
        (response) => response.text(),
      ),
      "segment",
    );
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});

test("非法 Range、弱或注入 ETag、非包体路径在发请求前拒绝", async () => {
  const { api } = await browserModules();
  const original = globalThis.fetch;
  let calls = 0;
  api.setCredential("synthetic-range");
  try {
    globalThis.fetch = async () => {
      calls += 1;
      throw new Error("UNEXPECTED_FETCH");
    };
    for (const range of [
      "bytes=0-262144",
      "bytes=5-4",
      "bytes=-1",
      "bytes=0-",
      "bytes=0-1,3-4",
      "bytes=8388608-8388608",
      "bytes=9007199254740992-9007199254740993",
      "bytes=0-1\r\nX-Test: yes",
    ]) {
      await assert.rejects(
        api.withResponse(path, { ticket, range }, () => {}),
        /INVALID_DOWNLOAD_RANGE/,
      );
    }
    for (const ifRange of [
      'W/"etag"',
      '"etag"\r\nX-Test: yes',
      "etag",
      '""',
      `"${"a".repeat(127)}"`,
    ]) {
      await assert.rejects(
        api.withResponse(path, { ticket, range: "bytes=0-1", ifRange }, () => {}),
        /INVALID_DOWNLOAD_RANGE/,
      );
    }
    for (const options of [
      { method: "POST" },
      { body: {} },
      { publicRead: true },
      { ticket: "bad" },
      { range: undefined, ifRange: '"etag"' },
    ]) {
      await assert.rejects(
        api.withResponse(path, { ticket, range: "bytes=0-1", ...options }, () => {}),
        /INVALID_DOWNLOAD_RANGE|INVALID_PUBLIC_API_PATH/,
      );
    }
    await assert.rejects(
      api.withResponse("/v1/me", { ticket, range: "bytes=0-1" }, () => {}),
      /INVALID_DOWNLOAD_RANGE/,
    );
    assert.equal(calls, 0);
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});

test("Range 请求在身份切换或停止后拒绝迟到响应并取消包体", async () => {
  const original = globalThis.fetch;
  try {
    for (const action of ["identity", "stop"]) {
      const { api } = await browserModules();
      api.setCredential("synthetic-range");
      let release;
      let cancelled = 0;
      let consumed = 0;
      globalThis.fetch = () =>
        new Promise((resolve) => {
          release = resolve;
        });
      const pending = api.withResponse(path, { ticket, range: "bytes=0-1" }, () => {
        consumed += 1;
      });
      const rejection = assert.rejects(pending, { name: "AbortError" });
      if (action === "identity") api.setCredential("another-synthetic");
      else api.stopRequests();
      release(
        new Response(
          new ReadableStream({
            cancel() {
              cancelled += 1;
            },
          }),
          { status: 206 },
        ),
      );
      await rejection;
      assert.equal(cancelled, 1);
      assert.equal(consumed, 0);
      api.stopRequests();
    }
  } finally {
    globalThis.fetch = original;
  }
});
