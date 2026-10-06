import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { fixture } from "./fixture.mjs";
import { assertNotPassed, cleanFact, queuedScan, runScanner } from "./scanner-fixture.mjs";

// 无 imports 的实际 transport 源码直接转译；不复制实现，不添加生产测试入口。
const source = await readFile(new URL("../src/scanner/transport.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText;
const { boundedFetch } = await import(
  `data:text/javascript;base64,${Buffer.from(compiled).toString("base64")}`
);

test("有界 fetch：中止立即退出，晚到响应被取消；已中止请求不启动调用", async () => {
  const controller = new AbortController();
  let resolve;
  const late = new Promise((done) => {
    resolve = done;
  });
  let cancelled = false;
  const pending = boundedFetch(
    { fetch: () => late },
    new Request("http://scanner/scan", { signal: controller.signal }),
  );
  await Promise.resolve();
  controller.abort();
  await assert.rejects(pending, /SCANNER_TIMEOUT/);
  resolve(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  await new Promise((done) => setImmediate(done));
  assert.equal(cancelled, true);
  let calls = 0;
  await assert.rejects(
    boundedFetch(
      {
        fetch: async () => {
          calls++;
          return new Response();
        },
      },
      new Request("http://scanner/scan", { signal: controller.signal }),
    ),
    /SCANNER_TIMEOUT/,
  );
  assert.equal(calls, 0);
});

test("75 秒 binding 不响应：任务有界回到 queued，不接纳迟到 clean", async (t) => {
  const f = await fixture();
  let observed, release;
  const captured = new Promise((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  let cancelled = false;
  try {
    const upload = await queuedScan(f);
    // 真实定时器已创建后 mock 不会接管，故在启动任务前启用。
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = runScanner(f, {
      fetch: async () => {
        observed();
        await barrier;
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    await captured;
    t.mock.timers.tick(75000);
    await pending;
    t.mock.timers.reset();
    await assertNotPassed(f, upload);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(cancelled, true);
  } finally {
    release();
    t.mock.timers.reset();
    await f.dispose();
  }
});

test("完整 JSON 后流不结束：超时取消 reader，不把取消产生的 EOF 当成 clean", async (t) => {
  const f = await fixture();
  let observed;
  const captured = new Promise((resolve) => {
    observed = resolve;
  });
  let cancelled = false;
  try {
    const upload = await queuedScan(f);
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const pending = runScanner(f, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(JSON.stringify(cleanFact(upload))));
            },
            pull() {
              observed();
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    await captured;
    // pull 的微任务可能先于客户端读循环，让其进入等待下一块的状态。
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(75000);
    await pending;
    t.mock.timers.reset();
    assert.equal(cancelled, true);
    await assertNotPassed(f, upload);
  } finally {
    t.mock.timers.reset();
    await f.dispose();
  }
});
