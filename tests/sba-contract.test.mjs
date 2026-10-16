import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("SBA 合同、只读验证、失败写入边界和数据保全", () => {
  const result = spawnSync("python", ["-B", "tests/sba_contract_checks.py"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SBA_CHECKS_PASSED/);
});

test("SBA 正式 Loom 客户端随原配置升级并在后续版本保留", () => {
  const result = spawnSync("python", ["-B", "tests/sba_native_client_checks.py"], {
    cwd: new URL("../", import.meta.url),
    encoding: "utf8",
    timeout: 30000,
    env: { ...process.env, PYTHONUTF8: "1", PYTHONDONTWRITEBYTECODE: "1" },
  });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /SBA_NATIVE_CLIENT_CHECKS_PASSED/);
});
