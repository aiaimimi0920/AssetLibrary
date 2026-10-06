import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { packSoftware } from "../scripts/pack-software.mjs";
import { artifactRoot, root } from "../scripts/source-scope.mjs";
import { fixture } from "./fixture.mjs";
import { checkedSoftware, softwareFiles } from "./software-package-fixture.mjs";
import { sha256 } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => f?.dispose());

async function recipe(directory, kind, files) {
  await writeFile(
    path.join(directory, "software-package.json"),
    JSON.stringify({ kind, files }, null, 2),
    "utf8",
  );
}
async function input(kind) {
  const directory = await mkdtemp(path.join(artifactRoot, "assetlibrary-software-input-"));
  const files = softwareFiles();
  for (const file of files) {
    const filename = path.join(directory, file.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, file.bytes, { flag: "wx" });
  }
  await recipe(
    directory,
    kind,
    files.map((file) => file.path),
  );
  return directory;
}

for (const kind of ["capability", "application"])
  test(`${kind} 真实打包 CLI → 原字节摘要 → Worker 检查；重复打包不覆盖候选`, async () => {
    const directory = await input(kind);
    const run = spawnSync(process.execPath, ["scripts/pack-software.mjs", directory], {
      cwd: root,
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    const bytes = await readFile(path.join(result.output, "package.zip"));
    assert.equal(bytes.readUInt16LE(8), 0);
    assert.equal(result.kind, kind);
    assert.equal(result.sha256, sha256(bytes));
    assert.equal(result.size, bytes.length);
    const receipt = JSON.parse(
      await readFile(path.join(result.output, "package-receipt.json"), "utf8"),
    );
    assert.equal(receipt.sha256, result.sha256);
    const { checked } = await checkedSoftware(f, kind, bytes);
    assert.equal(checked.result.kind, kind);
    assert.equal(checked.result.files.length, 2);
    const next = await packSoftware(directory);
    assert.notEqual(next.output, result.output);
    assert.equal(sha256(await readFile(path.join(result.output, "package.zip"))), result.sha256);
  });

test("软件 recipe 只允许显式安全路径、支持的 kind、1–32 文件；不读取链接和外根文件", async () => {
  const directory = await input("capability");
  for (const names of [
    [],
    ["../escape.js"],
    ["CON.bin"],
    ["manifest.json"],
    ["manifest.json/a.js"],
    ["runtime/main.js", "runtime/MAIN.JS"],
    ["runtime/main.js", "runtime/main.js/child.bin"],
    Array(33).fill("runtime/main.js"),
  ]) {
    await recipe(directory, "capability", names);
    await assert.rejects(packSoftware(directory));
  }
  await recipe(directory, "art", ["runtime/main.js"]);
  await assert.rejects(packSoftware(directory), /PACKAGE_RECIPE_INVALID/);
  const outside = await input("application");
  await symlink(outside, path.join(directory, "outside"), "junction");
  await recipe(directory, "capability", ["outside/runtime/main.js"]);
  await assert.rejects(packSoftware(directory), /PACKAGE_INPUT_OUTSIDE_ROOT/);
  await recipe(directory, "capability", ["outside"]);
  await assert.rejects(packSoftware(directory), /PACKAGE_INPUT_NOT_FILE/);
  await writeFile(path.join(directory, "empty.bin"), Buffer.alloc(0), { flag: "wx" });
  await recipe(directory, "capability", ["empty.bin"]);
  await assert.rejects(packSoftware(directory), /PACKAGE_INPUT_SIZE_LIMIT/);
  await writeFile(path.join(directory, "large.bin"), Buffer.alloc(1048577), { flag: "wx" });
  await recipe(directory, "capability", ["large.bin"]);
  await assert.rejects(packSoftware(directory), /PACKAGE_INPUT_SIZE_LIMIT/);
});
