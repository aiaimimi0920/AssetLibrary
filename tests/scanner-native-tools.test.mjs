import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { nativeCommand, verifyNativeContext } from "../scripts/scanner-native-tools.mjs";
import { sha256 } from "../scripts/scanner-release-policy.mjs";
import { artifactRoot, root } from "../scripts/source-scope.mjs";

await mkdir(artifactRoot, { recursive: true });
const output = await mkdtemp(path.join(artifactRoot, "assetlibrary-native-tools-test-"));

test("命令保留原始 UTF-8 stdout/stderr 日志并返回 stdout", async () => {
  const result = await nativeCommand(
    [process.execPath, "-e", "process.stdout.write('证据');process.stderr.write('diagnostic');"],
    output,
    "utf8",
  );
  assert.equal(result, "证据");
  const log = await readFile(path.join(output, "utf8.log"), "utf8");
  assert(log.includes("证据") && log.includes("diagnostic"));
});

test("失败命令关闭日志且不能覆盖已经存在的记录", async () => {
  await assert.rejects(
    nativeCommand(
      [process.execPath, "-e", "console.error('EXPECTED_FAILURE');process.exit(7);"],
      output,
      "failure",
    ),
    /NATIVE_COMMAND_FAILED:failure/,
  );
  assert.match(await readFile(path.join(output, "failure.log"), "utf8"), /EXPECTED_FAILURE/);
  await assert.rejects(nativeCommand([process.execPath, "--version"], output, "failure"), /EEXIST/);
});

test("超过时限的所属进程树被终止，日志名拒绝穿越", async () => {
  const started = Date.now();
  await assert.rejects(
    nativeCommand([process.execPath, "-e", "setInterval(()=>{},1000)"], output, "timeout", 1000),
    /TIMEOUT/,
  );
  assert(Date.now() - started < 15000);
  await assert.rejects(
    nativeCommand([process.execPath, "--version"], output, "../escape"),
    /NATIVE_LOG_NAME_INVALID/,
  );
});

test("冻结 context 的 archive、tree、recipe 和 APK 必须匹配初始身份", async () => {
  const context = await mkdtemp(path.join(output, "context-"));
  const recipeFile = "cargo-record.mjs";
  await copyFile(
    path.join(root, "scanner/native-build", recipeFile),
    path.join(context, recipeFile),
  );
  for (const file of ["source.tar", "source-tree.json", "cmake.apk"])
    await writeFile(path.join(context, file), file, { flag: "wx" });
  const input = {
    context,
    recipe: { [recipeFile]: sha256(await readFile(path.join(context, recipeFile))) },
    source: {
      archiveSha256: sha256(Buffer.from("source.tar")),
      treeSha256: sha256(Buffer.from("source-tree.json")),
    },
    cmake: { sha256: sha256(Buffer.from("cmake.apk")) },
  };
  await verifyNativeContext(input);
  await writeFile(path.join(context, "source.tar"), "changed");
  await assert.rejects(verifyNativeContext(input), /NATIVE_SOURCE_ARCHIVE_CHANGED/);
});
