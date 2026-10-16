import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { root } from "../scripts/source-scope.mjs";

test("预检命令输出原字节和保守回执，不把结构通过当作验签或安装通过", async () => {
  const dir = await mkdtemp(path.resolve(root, "../../linshi/loom-preflight-test-"));
  const input = path.join(dir, "input.zip");
  const bytes = artZip(
    [
      { path: "runtime/main.exe", bytes: Buffer.from("fixture only") },
      { path: "capability.manifest.json", bytes: Buffer.from('{"kind":"capability"}') },
    ],
    8,
  );
  await writeFile(input, bytes);
  const run = spawnSync(
    process.execPath,
    ["scripts/preflight-loom-package.mjs", "capability", input],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 45000,
    },
  );
  assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
  const output = run.stdout.trim().split("approval): ")[1];
  assert.ok(output);
  const receipt = JSON.parse(await readFile(path.join(output, "receipt.json"), "utf8"));
  assert.deepEqual(await readFile(path.join(output, "package.zip")), bytes);
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(receipt.originalBytesPreserved, true);
  for (const key of ["signatureVerified", "scanned", "productionEligible", "hostInstallVerified"])
    assert.equal(receipt[key], false);
});

test("预检命令拒绝未支持的类型及额外参数", () => {
  for (const args of [
    ["application", "missing.zip"],
    ["art", "missing.zip", "extra"],
  ]) {
    const run = spawnSync(process.execPath, ["scripts/preflight-loom-package.mjs", ...args], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /USAGE:/);
  }
});
