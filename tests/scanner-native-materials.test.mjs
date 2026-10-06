import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { cmakeMaterial, prepareCmakeMaterial } from "../scripts/scanner-native-materials.mjs";
import { artifactRoot } from "../scripts/source-scope.mjs";

await mkdir(artifactRoot, { recursive: true });
const root = await mkdtemp(path.join(artifactRoot, "assetlibrary-native-material-test-"));
const directory = async () => mkdtemp(path.join(root, "case-"));

test("固定 APK URL 无重定向且 HTTP 错误取消响应，不落盘", async () => {
  const output = await directory();
  let cancelled = false;
  await assert.rejects(
    prepareCmakeMaterial(output, undefined, async (url, options) => {
      assert.equal(url, cmakeMaterial.url);
      assert.equal(options.redirect, "error");
      return {
        status: 503,
        body: {
          cancel: async () => {
            cancelled = true;
          },
        },
      };
    }),
    /CMAKE_MATERIAL_HTTP_ERROR/,
  );
  assert(cancelled);
  await assert.rejects(access(path.join(output, "cmake.apk")), /ENOENT/);
});

test("截断、超限或摘要不匹配都取消 stream 且不保留部分 APK", async () => {
  for (const bytes of [
    Buffer.from("truncated"),
    Buffer.alloc(cmakeMaterial.bytes + 1),
    Buffer.alloc(cmakeMaterial.bytes),
  ]) {
    const output = await directory();
    let cancelled = false;
    let released = false;
    let sent = false;
    const fetcher = async () => ({
      status: 200,
      body: {
        getReader: () => ({
          read: async () => {
            if (sent) return { done: true };
            sent = true;
            return { done: false, value: bytes };
          },
          cancel: async () => {
            cancelled = true;
          },
          releaseLock: () => {
            released = true;
          },
        }),
      },
    });
    await assert.rejects(
      prepareCmakeMaterial(output, undefined, fetcher),
      /CMAKE_MATERIAL_(?:SIZE_MISMATCH|TOO_LARGE|DIGEST_MISMATCH)/,
    );
    assert(cancelled && released);
    await assert.rejects(access(path.join(output, "cmake.apk")), /ENOENT/);
  }
});

test("本地缓存也核长度和固定摘要，不信文件名", async () => {
  const output = await directory();
  const file = path.join(root, "wrong.apk");
  await writeFile(file, "wrong", { flag: "wx" });
  await assert.rejects(prepareCmakeMaterial(output, file), /CMAKE_MATERIAL_SIZE_MISMATCH/);
});
