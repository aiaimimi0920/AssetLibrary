import assert from "node:assert/strict";
import { test } from "node:test";
import { coreModules } from "./distribution-fixture.mjs";
import { captured } from "./operations-fixture.mjs";

test("响应观测不预读或缓冲流，保留 Range/缓存头且取消传递到底层 reader", async () => {
  const core = await coreModules();
  let pulls = 0;
  let cancelled;
  const stream = new ReadableStream(
    {
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel(reason) {
        cancelled = reason;
      },
    },
    { highWaterMark: 0 },
  );
  const response = new Response(stream, {
    status: 206,
    headers: {
      "Content-Range": "bytes 0-2/6",
      "Content-Length": "3",
      "Cache-Control": "private, no-store",
      "Content-Type": "application/octet-stream",
    },
  });
  const result = await captured(async () =>
    core.observeResponse(
      new Request("http://localhost/v1/publications/private-id/content?ticket=PRIVATE_DO_NOT_LOG"),
      response,
      "11111111-1111-4111-8111-111111111111",
      performance.now(),
    ),
  );
  assert.equal(pulls, 0);
  assert.equal(result.value.status, 206);
  assert.equal(result.value.headers.get("content-range"), "bytes 0-2/6");
  assert.equal(result.value.headers.get("content-length"), "3");
  assert.equal(result.value.headers.get("cache-control"), "private, no-store");
  assert.equal(result.value.headers.get("content-type"), "application/octet-stream");
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0].event, "http.response_ready");
  assert.ok(!JSON.stringify(result.events).includes("PRIVATE_"));
  const reader = result.value.body.getReader();
  try {
    assert.deepEqual((await reader.read()).value, new Uint8Array([1, 2, 3]));
    assert.equal(pulls, 1);
    await reader.cancel("TEST_CANCEL");
    assert.equal(cancelled, "TEST_CANCEL");
    assert.equal(pulls, 1);
  } finally {
    reader.releaseLock();
  }
});
