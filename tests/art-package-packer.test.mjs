import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { packArt } from "../scripts/pack-art.mjs";
import { artifactRoot, root } from "../scripts/source-scope.mjs";
import { images, inspectPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { png } from "./inspection-fixture.mjs";
import { sha256 } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});
async function input(files = images()) {
  const directory = await mkdtemp(path.join(artifactRoot, "assetlibrary-art-input-"));
  for (const file of files) {
    const filename = path.join(directory, file.path);
    await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filename, file.bytes, { flag: "wx" });
  }
  await recipe(
    directory,
    files.map((file) => file.path),
  );
  return directory;
}
async function recipe(directory, files) {
  await writeFile(path.join(directory, "art-package.json"), JSON.stringify({ files }), "utf8");
}

test("真实打包 CLI 生成 Stored 多文件候选；摘要 receipt 与 Worker 接收的包一致且不覆盖", async () => {
  const directory = await input();
  const run = spawnSync(process.execPath, ["scripts/pack-art.mjs", directory], {
    cwd: root,
    encoding: "utf8",
    timeout: 10000,
  });
  assert.equal(run.status, 0, run.stderr);
  const result = JSON.parse(run.stdout);
  const bytes = await readFile(path.join(result.output, "package.zip"));
  assert.equal(bytes.readUInt16LE(8), 0);
  assert.equal(result.sha256, sha256(bytes));
  assert.equal(result.size, bytes.length);
  assert.equal(result.files, 2);
  const receipt = JSON.parse(
    await readFile(path.join(result.output, "package-receipt.json"), "utf8"),
  );
  assert.equal(receipt.sha256, sha256(bytes));
  await inspectPackage(f, bytes);
  const second = await packArt(directory);
  assert.notEqual(second.output, result.output);
  assert.equal(sha256(await readFile(path.join(result.output, "package.zip"))), result.sha256);
});

test("打包 recipe 穿越、设备名、大小写/祖先碰撞、非 PNG 与条目数量失败关闭", async () => {
  const directory = await input();
  for (const names of [
    [],
    ["../escape.png"],
    ["CON.png"],
    ["A.png", "a.png"],
    ["sprites/hero.png", "SPRITES/HERO.PNG"],
    ["sprites/hero.png", "sprites/hero.png/child.png"],
    ["file.js"],
    ["manifest.json/a.png"],
    Array(33).fill("sprites/hero.png"),
  ]) {
    await recipe(directory, names);
    await assert.rejects(packArt(directory));
  }
});

test("打包拒绝直属 junction、父目录出根 junction 与非普通文件；不会读取外根 PNG", async () => {
  const directory = await input();
  const outside = await input([{ path: "outside.png", bytes: png() }]);
  await symlink(outside, path.join(directory, "outside"), "junction");
  await recipe(directory, ["outside/outside.png"]);
  await assert.rejects(packArt(directory), /PACKAGE_INPUT_OUTSIDE_ROOT/);
  // 无需 Windows 文件 symlink 特权，真实 junction 覆盖直属链接和父目录出根分支。
  await symlink(outside, path.join(directory, "linked.png"), "junction");
  await recipe(directory, ["linked.png"]);
  await assert.rejects(packArt(directory), /PACKAGE_INPUT_NOT_FILE/);
  await mkdir(path.join(directory, "folder.png"));
  await recipe(directory, ["folder.png"]);
  await assert.rejects(packArt(directory), /PACKAGE_INPUT_NOT_FILE/);
});

test("打包工具仅浅查 PNG，坏 CRC 仍由 Worker 完整检查拒绝，不冒充安全通过", async () => {
  const broken = png();
  broken[broken.length - 1] ^= 1;
  const directory = await input([{ path: "broken.png", bytes: broken }]);
  const result = await packArt(directory);
  await inspectPackage(
    f,
    await readFile(path.join(result.output, "package.zip")),
    "rejected",
    "PNG_CRC_INVALID",
  );
});
