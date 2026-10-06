import assert from "node:assert/strict";
import { test } from "node:test";
import { disposeScannerFixture } from "../scripts/verify-scanner.mjs";

test("fixture 销毁失败也必须清理 scanner，且仍报告失败", async () => {
  const calls = [];
  await assert.rejects(
    disposeScannerFixture(
      {
        async dispose() {
          calls.push("fixture");
          throw new Error("FIXTURE_DISPOSE_FAILED");
        },
      },
      {
        async cleanup() {
          calls.push("scanner");
        },
      },
    ),
    /FIXTURE_DISPOSE_FAILED/,
  );
  assert.deepEqual(calls, ["fixture", "scanner"]);
});

test("fixture 尚未创建时仍清理 scanner；容器清理失败不吞掉", async () => {
  let calls = 0;
  await assert.rejects(
    disposeScannerFixture(undefined, {
      async cleanup() {
        calls++;
        throw new Error("SCANNER_CLEANUP_FAILED");
      },
    }),
    /SCANNER_CLEANUP_FAILED/,
  );
  assert.equal(calls, 1);
});

test("正常收尾按 owner 顺序执行各一次", async () => {
  const calls = [];
  await disposeScannerFixture(
    {
      async dispose() {
        calls.push("fixture");
      },
    },
    {
      async cleanup() {
        calls.push("scanner");
      },
    },
  );
  assert.deepEqual(calls, ["fixture", "scanner"]);
});
