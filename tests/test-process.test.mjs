import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { root } from "../scripts/source-scope.mjs";
import { runTestProcess } from "../scripts/test-process.mjs";

async function logPath() {
  const parent = path.resolve(root, "../../linshi");
  await mkdir(parent, { recursive: true });
  return path.join(await mkdtemp(path.join(parent, "assetlibrary-test-process-")), "tests.log");
}

test("超过默认缓冲预算的 stdout/stderr 完整落盘且正常退出", async () => {
  const target = await logPath();
  const result = runTestProcess(
    [
      "-e",
      "require('fs').writeSync(1, 'x'.repeat(2 * 1024 * 1024)); require('fs').writeSync(2, '日志结束');",
    ],
    { logPath: target, timeout: 10000 },
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.error, undefined);
  assert.equal(await readFile(target, "utf8"), `${"x".repeat(2 * 1024 * 1024)}日志结束`);
});

test("非零退出不能被日志写入成功覆盖，已有日志不可覆盖", async () => {
  const target = await logPath();
  const result = runTestProcess(["-e", "console.error('expected failure'); process.exitCode = 7"], {
    logPath: target,
    timeout: 10000,
  });
  assert.equal(result.exitCode, 7);
  assert.match(await readFile(target, "utf8"), /expected failure/);
  assert.throws(() => runTestProcess(["-e", ""], { logPath: target }), { code: "EEXIST" });
});

test("超时仍返回失败并关闭日志句柄", async () => {
  const target = await logPath();
  const result = runTestProcess(["-e", "setInterval(() => {}, 1000)"], {
    logPath: target,
    timeout: 300,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(typeof (await readFile(target, "utf8")), "string");
});
