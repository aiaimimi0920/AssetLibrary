import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { browserModules } from "./web-client-fixture.mjs";

const bytes = Buffer.alloc(600000, 42);
const metadata = () => ({
  id: randomUUID(),
  versionId: randomUUID(),
  size: bytes.length,
  sha256: createHash("sha256").update(bytes).digest("hex"),
});
function segment(options, row, changes = {}) {
  const [start, end] = options.headers.Range.slice(6).split("-").map(Number);
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      "content-type": "application/zip",
      "content-range": `bytes ${start}-${end}/${row.size}`,
      etag: '"stable"',
      ...changes,
    },
  });
}
async function harness(task) {
  const modules = await browserModules();
  const original = globalThis.fetch;
  modules.api.setCredential("synthetic-resume");
  const transfer = modules.resume.createDownloadTransfer();
  const row = metadata();
  const requests = [];
  let tickets = 0;
  let content = (options) => segment(options, row);
  globalThis.fetch = async (_path, options) => {
    if (options.method === "POST") {
      tickets += 1;
      return Response.json({
        publicationId: row.id,
        contentPath: `/v1/publications/${row.id}/content`,
        ticket: String(tickets).padStart(64, "a"),
      });
    }
    requests.push(options);
    return content(options);
  };
  try {
    await task({
      ...modules,
      transfer,
      row,
      requests,
      tickets: () => tickets,
      content: (value) => {
        content = value;
      },
    });
  } finally {
    transfer.dispose();
    modules.api.stopRequests();
    globalThis.fetch = original;
  }
}

test("中断只保留完整段，无自动重试；继续申请新票据并从完整 offset 校验后返回包体", async () =>
  harness(async (h) => {
    h.content((options) => {
      if (h.requests.length === 2) throw new TypeError("network interrupted");
      return segment(options, h.row);
    });
    await assert.rejects(h.transfer.fetch(h.row), /network interrupted/);
    assert.equal(h.transfer.snapshot().offset, 262144);
    assert.equal(h.transfer.snapshot().resumable, true);
    assert.equal(h.requests.length, 2);
    assert.equal(h.tickets(), 1);
    const result = await h.transfer.fetch(null, undefined, true);
    assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
    assert.equal(result.versionId, h.row.versionId);
    assert.equal(h.tickets(), 2);
    assert.equal(h.requests[2].headers.Range, "bytes=262144-524287");
    assert.equal(h.requests[2].headers["If-Range"], '"stable"');
    assert.notEqual(
      h.requests[0].headers["X-Download-Ticket"],
      h.requests[2].headers["X-Download-Ticket"],
    );
    assert.equal(h.transfer.snapshot(), null);
  }));

test("截断段不提交，协议/ETag/最终摘要不匹配与授权撤销均清空", async () => {
  for (const failure of ["etag", "range", "status", "digest", "revoked"])
    await harness(async (h) => {
      h.content((options) => {
        if (h.requests.length === 1) return segment(options, h.row);
        if (failure === "revoked") return Response.json({ error: "NOT_FOUND" }, { status: 404 });
        if (failure === "status") return new Response(bytes, { status: 200 });
        if (failure === "digest") return segment(options, h.row);
        return segment(
          options,
          h.row,
          failure === "etag" ? { etag: '"changed"' } : { "content-range": "bytes 0-1/2" },
        );
      });
      if (failure === "digest") h.row.sha256 = "0".repeat(64);
      await assert.rejects(h.transfer.fetch(h.row));
      assert.equal(h.transfer.snapshot(), null);
      const before = h.requests.length;
      await assert.rejects(h.transfer.fetch(null, undefined, true), /NO_RESUMABLE_DOWNLOAD/);
      assert.equal(h.requests.length, before);
    });
  await harness(async (h) => {
    h.content((options) =>
      h.requests.length === 2
        ? new Response("short", {
            status: 206,
            headers: {
              "content-type": "application/zip",
              "content-range": `bytes 262144-524287/${h.row.size}`,
              etag: '"stable"',
            },
          })
        : segment(options, h.row),
    );
    await assert.rejects(h.transfer.fetch(h.row), /DOWNLOAD_TRUNCATED/);
    assert.equal(h.transfer.snapshot().offset, 262144);
  });
});

test("停止、切换身份、放弃清空待续传；三次手动失败耗尽且并发不启动请求", async () => {
  for (const action of ["stop", "identity", "discard", "limit"])
    await harness(async (h) => {
      h.content((options) => {
        if (h.requests.length > 1) throw new TypeError("offline");
        return segment(options, h.row);
      });
      await assert.rejects(h.transfer.fetch(h.row));
      if (action === "stop") h.api.stopRequests();
      if (action === "identity") h.api.setCredential("other");
      if (action === "discard") h.transfer.clear();
      if (action === "limit") {
        await assert.rejects(h.transfer.fetch(null, undefined, true));
        assert.ok(h.transfer.snapshot());
        await assert.rejects(h.transfer.fetch(null, undefined, true));
        assert.equal(h.tickets(), 3);
      }
      assert.equal(h.transfer.snapshot(), null);
    });
  await harness(async (h) => {
    let release;
    let cancelled = 0;
    h.content(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const pending = h.transfer.fetch(h.row);
    const rejected = assert.rejects(pending, { name: "AbortError" });
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    await assert.rejects(h.transfer.fetch(h.row), /DOWNLOAD_ALREADY_RUNNING/);
    h.transfer.clear();
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
    await rejected;
    assert.equal(h.transfer.snapshot(), null);
    assert.equal(cancelled, 1);
  });
});

test("整轮超时或外部取消丢弃完整段并释放计时器与流", async () => {
  for (const action of ["timeout", "abort"])
    await harness(async (h) => {
      const originalSet = globalThis.setTimeout;
      const originalClear = globalThis.clearTimeout;
      const timers = new Map();
      let next = 0;
      globalThis.setTimeout = (callback, delay) => {
        const id = ++next;
        timers.set(id, { callback, delay });
        return id;
      };
      globalThis.clearTimeout = (id) => {
        timers.delete(id);
      };
      let cancelled = 0;
      let entered;
      const waiting = new Promise((resolve) => {
        entered = resolve;
      });
      h.content((options) => {
        if (h.requests.length === 1) return segment(options, h.row);
        entered();
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled += 1;
            },
          }),
          {
            status: 206,
            headers: {
              "content-type": "application/zip",
              "content-range": `bytes 262144-524287/${h.row.size}`,
              etag: '"stable"',
            },
          },
        );
      });
      const controller = new AbortController();
      try {
        const pending = h.transfer.fetch(h.row, controller.signal);
        const rejected = assert.rejects(pending, { name: "AbortError" });
        await waiting;
        if (action === "timeout") {
          assert.equal(timers.get(1).delay, 120000);
          timers.get(1).callback();
        } else controller.abort();
        await rejected;
        assert.equal(h.transfer.snapshot(), null);
        assert.equal(cancelled, 1);
        assert.equal(timers.size, 0);
      } finally {
        globalThis.setTimeout = originalSet;
        globalThis.clearTimeout = originalClear;
      }
    });
});
