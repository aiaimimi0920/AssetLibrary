import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { bindNativeSource, nativePatch } from "../scanner/native-build/source-patches.mjs";

test("固定 7z 补丁字节和上游来源不可漂移", async () => {
  const bytes = await readFile(
    new URL("../scanner/native-build/7z-pack-streams.patch", import.meta.url),
  );
  assert.equal(createHash("sha256").update(bytes).digest("hex"), nativePatch.patchSha256);
  assert.match(bytes.toString(), /From 364526c74f8fdb961326ae89a2ac19d291a521e4 /);
});

test("7z 未修补字节、错误上游及未知源码修改不能获得绑定", () => {
  assert.throws(
    () => bindNativeSource(Buffer.from("unpatched"), nativePatch.upstream, nativePatch.file),
    /NATIVE_PATCH_OUTPUT_CHANGED/,
  );
  assert.throws(
    () => bindNativeSource(Buffer.alloc(0), "0".repeat(40), nativePatch.file),
    /NATIVE_PATCH_UPSTREAM_CHANGED/,
  );
  assert.throws(
    () => bindNativeSource(Buffer.from("changed"), nativePatch.upstream, "other.c"),
    /SOURCE_BLOB_MISMATCH/,
  );
});

test("补丁必须在 vendor 与编译之前断网应用，边界探针使用真实源码", async () => {
  const dockerfile = await readFile(
    new URL("../scanner/native-build/Dockerfile", import.meta.url),
    "utf8",
  );
  const patchStep = dockerfile.indexOf("RUN --network=none node /opt/native/source-patches.mjs");
  const vendorStep = dockerfile.indexOf("cargo vendor");
  assert(patchStep >= 0 && vendorStep >= 0 && patchStep < vendorStep);
  assert.match(dockerfile, /ASAN_OPTIONS=halt_on_error=1 UBSAN_OPTIONS=halt_on_error=1/);
  assert.match(dockerfile, /7z-pack-streams-sanitizer\.log 2>&1/);
  const probe = await readFile(
    new URL("../scanner/native-build/7z-pack-streams-test.c", import.meta.url),
    "utf8",
  );
  assert.match(probe, /#include "7zIn.c"/);
  assert.equal(probe.match(/assert\(SzAr_CheckPackStreams/g).length, 7);
});
