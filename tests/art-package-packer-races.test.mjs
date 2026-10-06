import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import { packArt } from "../scripts/pack-art.mjs";
import { artifactRoot } from "../scripts/source-scope.mjs";
import { png } from "./inspection-fixture.mjs";

async function input() {
  const directory = await fs.mkdtemp(path.join(artifactRoot, "assetlibrary-art-race-"));
  await fs.writeFile(path.join(directory, "image.png"), png(), { flag: "wx" });
  await fs.writeFile(
    path.join(directory, "art-package.json"),
    JSON.stringify({ files: ["image.png"] }),
    { encoding: "utf8", flag: "wx" },
  );
  return directory;
}

/** 仅测试宿主替换文件 API，模拟 open 的实际目标变化；不为生产工具增加故障入口。 */
function observeHandle(handle, state, beforeRead) {
  return new Proxy(handle, {
    get(target, name) {
      if (name === "read")
        return async (...args) => {
          state.reads++;
          await beforeRead?.();
          return target.read(...args);
        };
      if (name === "close")
        return async () => {
          state.closed++;
          return target.close();
        };
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

test("打包 open 实际对象与 lstat 不同：在读取外根字节前拒绝并关闭已打开句柄", async (t) => {
  const directory = await input();
  const outside = await input();
  const original = fs.open;
  const state = { reads: 0, closed: 0 };
  t.mock.method(fs, "open", async (filename, ...args) => {
    if (filename !== path.join(directory, "image.png")) return original(filename, ...args);
    return observeHandle(await original(path.join(outside, "image.png"), ...args), state);
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(packArt(directory), /PACKAGE_INPUT_CHANGED/);
    assert.equal(state.reads, 0);
    assert.equal(state.closed, 1);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test("打包读取期间文件增大：拒绝部分/混合快照并关闭句柄", async (t) => {
  const directory = await input();
  const original = fs.open;
  const state = { reads: 0, closed: 0 };
  let changed = false;
  t.mock.method(fs, "open", async (filename, ...args) => {
    const handle = await original(filename, ...args);
    if (filename !== path.join(directory, "image.png")) return handle;
    return observeHandle(handle, state, async () => {
      if (!changed) {
        changed = true;
        await fs.appendFile(filename, "changed");
      }
    });
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(packArt(directory), /PACKAGE_INPUT_CHANGED/);
    assert.equal(state.closed, 1);
    assert.ok(state.reads > 0);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});
