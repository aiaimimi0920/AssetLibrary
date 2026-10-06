import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { browserModules } from "./web-client-fixture.mjs";

const bytes = Buffer.from("test-only-art-package");
const publication = () => ({
  id: randomUUID(),
  versionId: randomUUID(),
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
const reply = (body = bytes, changes = {}) =>
  new Response(body, {
    headers: {
      "content-type": "application/zip",
      "content-length": String(bytes.length),
      ...changes,
    },
  });

test("公开目录无身份可读取且不携带 Bearer；公开读取选项不能改为其他 API 或写入", async () => {
  const { api } = await browserModules();
  const original = globalThis.fetch;
  try {
    globalThis.fetch = async (path, options) => {
      assert.equal(path, "/v1/catalog?limit=20");
      assert.equal(options.headers.Authorization, undefined);
      return Response.json({ items: [], nextAfter: null });
    };
    assert.deepEqual(await api.api("/v1/catalog?limit=20", { publicRead: true }), {
      items: [],
      nextAfter: null,
    });
    api.setCredential("synthetic-private");
    await api.api("/v1/catalog?limit=20", { publicRead: true });
    await assert.rejects(api.api("/v1/me", { publicRead: true }), /INVALID_PUBLIC_API_PATH/);
    await assert.rejects(
      api.api("/v1/catalog", { method: "POST", publicRead: true }),
      /INVALID_PUBLIC_API_PATH/,
    );
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});

test("票据只进 header，二进制请求同源、无 cookie；长度和 SHA-256 校验后才返回 Blob", async () => {
  const { api, download } = await browserModules();
  const original = globalThis.fetch;
  const row = publication();
  const token = "a".repeat(64);
  const calls = [];
  api.setCredential("synthetic");
  try {
    globalThis.fetch = async (path, options) => {
      calls.push(path);
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.headers.Authorization, "Bearer synthetic");
      if (options.method === "POST")
        return Response.json({
          publicationId: row.id,
          ticket: token,
          contentPath: `/v1/publications/${row.id}/content`,
        });
      assert.equal(options.headers["X-Download-Ticket"], token);
      return reply();
    };
    const progress = [];
    const blob = await download.fetchPackage(row, new AbortController().signal, (done) =>
      progress.push(done),
    );
    assert.equal(blob.type, "application/zip");
    assert.deepEqual(Buffer.from(await blob.arrayBuffer()), bytes);
    assert.deepEqual(progress, [bytes.length]);
    assert.ok(calls.every((path) => !path.includes(token)));
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});

test("畸形票据、外部路径和大于包体上限的元数据在读取包体前拒绝", async () => {
  const { api, download } = await browserModules();
  api.setCredential("synthetic");
  const original = globalThis.fetch;
  const row = publication();
  try {
    await assert.rejects(
      download.fetchPackage({ ...row, size: 8388609 }, new AbortController().signal),
      /INVALID_DOWNLOAD_METADATA/,
    );
    for (const changes of [
      { contentPath: "https://other.test/file" },
      { ticket: "not-opaque" },
      { publicationId: randomUUID() },
    ]) {
      globalThis.fetch = async () =>
        Response.json({
          publicationId: row.id,
          ticket: "a".repeat(64),
          contentPath: `/v1/publications/${row.id}/content`,
          ...changes,
        });
      await assert.rejects(
        download.fetchPackage(row, new AbortController().signal),
        /DOWNLOAD_TICKET_INVALID/,
      );
    }
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});

test("保存使用中性包名；非法版本不创建 URL，点击成功或失败都回收临时资源", async (t) => {
  const { download } = await browserModules();
  const original = Object.getOwnPropertyDescriptor(globalThis, "document");
  const blob = new Blob([bytes], { type: "application/zip" });
  const versionId = randomUUID();
  const events = [];
  const timers = [];
  let failClick = false;
  const link = {
    click() {
      events.push("click");
      if (failClick) throw new Error("SAVE_CLICK_FAILED");
    },
    remove() {
      events.push("remove");
    },
  };
  globalThis.document = {
    createElement(tag) {
      assert.equal(tag, "a");
      return link;
    },
    body: { append: (element) => assert.equal(element, link) },
  };
  t.mock.method(URL, "createObjectURL", (value) => {
    assert.equal(value, blob);
    events.push("create");
    return "blob:package-test";
  });
  t.mock.method(URL, "revokeObjectURL", (url) => {
    assert.equal(url, "blob:package-test");
    events.push("revoke");
  });
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    assert.equal(delay, 1000);
    timers.push(callback);
  });
  try {
    assert.throws(() => download.savePackage(blob, "../invalid"), /INVALID_DOWNLOAD_METADATA/);
    assert.deepEqual(events, []);
    for (failClick of [false, true]) {
      events.length = 0;
      if (failClick)
        assert.throws(() => download.savePackage(blob, versionId), /SAVE_CLICK_FAILED/);
      else download.savePackage(blob, versionId);
      assert.equal(link.download, `package-${versionId}.zip`);
      assert.equal(link.href, "blob:package-test");
      assert.deepEqual(events, ["create", "click", "remove"]);
      assert.equal(timers.length, 1);
      timers.shift()();
      assert.deepEqual(events, ["create", "click", "remove", "revoke"]);
    }
  } finally {
    if (original) Object.defineProperty(globalThis, "document", original);
    else delete globalThis.document;
  }
});

test("包体截断/越声明长度/摘要不匹配不产生 Blob，并释放 reader", async () => {
  const { download } = await browserModules();
  const signal = new AbortController().signal;
  for (const [body, error] of [
    [bytes.subarray(1), /DOWNLOAD_TRUNCATED/],
    [Buffer.concat([bytes, bytes]), /DOWNLOAD_SIZE_EXCEEDED/],
    [Buffer.alloc(bytes.length), /DOWNLOAD_DIGEST_MISMATCH/],
  ]) {
    const response = reply(body);
    await assert.rejects(download.readPackage(response, signal, publication()), error);
    assert.equal(response.body.locked, false);
  }
  await assert.rejects(
    download.readPackage(reply(bytes, { "content-type": "text/html" }), signal, publication()),
    /DOWNLOAD_RESPONSE_INVALID/,
  );
});

test("无 Content-Length 的流式响应仍校验完整字节和摘要，有声明的畸形长度拒绝", async () => {
  const { download } = await browserModules();
  const signal = new AbortController().signal;
  for (const [body, error] of [
    [bytes, null],
    [bytes.subarray(1), /DOWNLOAD_TRUNCATED/],
    [Buffer.concat([bytes, bytes]), /DOWNLOAD_SIZE_EXCEEDED/],
    [Buffer.alloc(bytes.length), /DOWNLOAD_DIGEST_MISMATCH/],
  ]) {
    const response = reply(body);
    response.headers.delete("content-length");
    const pending = download.readPackage(response, signal, publication());
    if (error) await assert.rejects(pending, error);
    else assert.deepEqual(Buffer.from(await (await pending).arrayBuffer()), bytes);
    assert.equal(response.body.locked, false);
  }
  for (const length of ["", "0", "-1", "20.0", "2e1", "020", String(bytes.length + 1)]) {
    const response = reply(bytes, { "content-length": length });
    await assert.rejects(
      download.readPackage(response, signal, publication()),
      /DOWNLOAD_RESPONSE_INVALID/,
    );
    await response.body.cancel();
  }
});

test("身份切换、停止和已中止请求取消正在等待的包体，不保留旧身份字节", async () => {
  const original = globalThis.fetch;
  try {
    for (const action of ["identity", "stop", "abort"]) {
      const { api, download } = await browserModules();
      api.setCredential("old-synthetic");
      const row = publication();
      let cancelled = 0;
      let observed;
      const reading = new Promise((resolve) => {
        observed = resolve;
      });
      globalThis.fetch = async (_path, options) =>
        options.method === "POST"
          ? Response.json({
              publicationId: row.id,
              ticket: "a".repeat(64),
              contentPath: `/v1/publications/${row.id}/content`,
            })
          : reply(
              new ReadableStream({
                pull() {
                  observed();
                },
                cancel() {
                  cancelled++;
                },
              }),
            );
      const control = new AbortController();
      const pending = assert.rejects(download.fetchPackage(row, control.signal), {
        name: "AbortError",
      });
      await reading;
      if (action === "identity") api.setCredential("new-synthetic");
      else if (action === "stop") api.stopRequests();
      else control.abort();
      await pending;
      assert.equal(cancelled, 1, action);
    }
  } finally {
    globalThis.fetch = original;
  }
});

test("身份已切换后才返回的响应主动取消，错误仍保留 status/code 供授权查询恢复", async () => {
  const { api } = await browserModules();
  const original = globalThis.fetch;
  try {
    api.setCredential("old");
    let release;
    let cancelled = 0;
    globalThis.fetch = async () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const pending = assert.rejects(api.api("/v1/me"), { name: "AbortError" });
    api.setCredential("new");
    release(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled++;
          },
        }),
      ),
    );
    await pending;
    assert.equal(cancelled, 1);
    globalThis.fetch = async () => Response.json({ error: "NOT_FOUND" }, { status: 404 });
    await assert.rejects(
      api.api("/v1/me"),
      (error) => error.status === 404 && error.code === "NOT_FOUND",
    );
  } finally {
    api.stopRequests();
    globalThis.fetch = original;
  }
});
