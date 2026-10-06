import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  nativeEnginePaths,
  verifyInstalledEngine,
} from "../scripts/scanner-native-installation.mjs";

function identity() {
  const installed = {};
  const binaries = {};
  for (const name of nativeEnginePaths) {
    installed[name.slice(1)] = { sha256: "a".repeat(64) };
    binaries[name] = { path: name, sha256: "a".repeat(64) };
  }
  return { installed, binaries };
}

test("运行服务必须使用全部五项本轮安装引擎二进制", () => {
  const input = identity();
  verifyInstalledEngine(input.installed, input.binaries);
  for (const name of nativeEnginePaths) {
    const changed = identity();
    changed.binaries[name].sha256 = "b".repeat(64);
    assert.throws(
      () => verifyInstalledEngine(changed.installed, changed.binaries),
      /NATIVE_PRODUCT_BINARY_CHANGED/,
    );
  }
});

test("缺失引擎、非安装路径或无效摘要必须拒绝", () => {
  for (const mutate of [
    (input) => {
      delete input.binaries[nativeEnginePaths[0]];
    },
    (input) => {
      input.binaries[nativeEnginePaths[0]].path = "/tmp/fake";
    },
    (input) => {
      input.binaries[nativeEnginePaths[0]].sha256 = "";
    },
  ]) {
    const input = identity();
    mutate(input);
    assert.throws(() => verifyInstalledEngine(input.installed, input.binaries), /NATIVE_PRODUCT_/);
  }
});

test("不能用另一个合法安装文件的路径和摘要冒充所要求的引擎", () => {
  const input = identity();
  for (const name of nativeEnginePaths)
    input.binaries[name] = { ...input.binaries[nativeEnginePaths[0]] };
  assert.throws(
    () => verifyInstalledEngine(input.installed, input.binaries),
    /NATIVE_PRODUCT_BINARY_PATH_MISMATCH/,
  );
});

test("运行 realpath 必须匹配安装清单中的完整符号链接链", () => {
  const input = identity();
  const name = nativeEnginePaths[1];
  const target = `${name}.1.0`;
  input.installed[name.slice(1)] = { link: "libclamav.intermediate" };
  input.installed["usr/lib/libclamav.intermediate"] = { link: target };
  input.installed[target.slice(1)] = { sha256: "a".repeat(64) };
  input.binaries[name] = { path: target, sha256: "a".repeat(64) };
  verifyInstalledEngine(input.installed, input.binaries);
  input.binaries[name].path = "/usr/bin/clamscan";
  assert.throws(() => verifyInstalledEngine(input.installed, input.binaries), /PATH_MISMATCH/);
});

test("安装链接循环、悬空、逃逸、非法或混合身份都失败关闭", () => {
  const name = nativeEnginePaths[1];
  for (const record of [
    { link: "libclamav.so.12" },
    { link: "missing" },
    { link: "../../../tmp/fake" },
    { link: "/tmp/fake" },
    { link: "C:\\fake" },
    { link: "missing/../libclamav.so.12.1.0" },
    { link: "subdirectory/libclamav.so.12.1.0" },
    { link: "/usr/lib/./libclamav.so.12.1.0" },
    { link: "." },
    { link: ".." },
    { link: "" },
    { link: 123 },
    { link: "libclamav.so.12", sha256: "a".repeat(64) },
  ]) {
    const input = identity();
    input.installed[name.slice(1)] = record;
    assert.throws(() => verifyInstalledEngine(input.installed, input.binaries), /NATIVE_INSTALL_/);
  }
});

test("跨多个安装项的循环不会被报告路径或摘要掩盖", () => {
  const input = identity();
  input.installed["usr/lib/libclamav.so.12"] = { link: "second" };
  input.installed["usr/lib/second"] = { link: "libclamav.so.12" };
  assert.throws(() => verifyInstalledEngine(input.installed, input.binaries), /LINK_CYCLE/);
});

test("过深的安装链接链有固定执行上限", () => {
  const input = identity();
  const name = nativeEnginePaths[1];
  input.installed[name.slice(1)] = { link: "hop-0" };
  for (let index = 0; index < 16; index++)
    input.installed[`usr/lib/hop-${index}`] = { link: `hop-${index + 1}` };
  input.installed["usr/lib/hop-16"] = { sha256: "a".repeat(64) };
  input.binaries[name] = { path: "/usr/lib/hop-16", sha256: "a".repeat(64) };
  assert.throws(
    () => verifyInstalledEngine(input.installed, input.binaries),
    /LINK_DEPTH_EXCEEDED/,
  );
});

test("候选配方在签名更新前安装受控产物，运行期仍无编译工具链", async () => {
  const recipe = await readFile(
    new URL("../scanner/native-runtime.Dockerfile", import.meta.url),
    "utf8",
  );
  assert(recipe.indexOf("ADD install.tar /") < recipe.indexOf("freshclam --user=root"));
  assert.match(recipe, /ARG SCANNER_SIGNATURE_REFRESH=unmanaged/);
  assert.match(recipe, /USER clamav/);
  assert(!/apk add[^\n]*(?:cargo|rust|g\+\+|gcc)/.test(recipe));
});
