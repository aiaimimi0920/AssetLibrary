import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindSourceBlob } from "./source-exports.mjs";

// 固定上游补丁，不允许模糊匹配或将修改后的字节冒充原始源码。
export const nativePatch = Object.freeze({
  id: "CLAM-3065",
  file: "libclamav/7z/7zIn.c",
  upstream: "646c4a1a1c35484dcf186806689ed7b8fe6326b3",
  patched: "c58a7830679a4b6c30839e2864da3353fc752a9a",
  sha256: "abbeefd3cb30dd0becc6968f359e37db2e61e518596e81ce7140e14fa1331e2b",
  patchSha256: "64ae95c9aed0bfd5ed4add6e5bf7b9df23be4573900c15a125527db42ad094db",
});
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function bindNativeSource(bytes, expected, file) {
  if (file !== nativePatch.file) return bindSourceBlob(bytes, expected);
  assert.equal(expected, nativePatch.upstream, "NATIVE_PATCH_UPSTREAM_CHANGED");
  assert.equal(digest(bytes), nativePatch.sha256, "NATIVE_PATCH_OUTPUT_CHANGED");
  return {
    ...bindSourceBlob(bytes, nativePatch.patched),
    upstreamGitBlob: expected,
    patchId: nativePatch.id,
    patchSha256: nativePatch.patchSha256,
  };
}

export async function applyNativePatch(sourceRoot, patchFile) {
  const patch = await readFile(patchFile);
  assert.equal(digest(patch), nativePatch.patchSha256, "NATIVE_PATCH_BYTES_CHANGED");
  const target = path.join(sourceRoot, nativePatch.file);
  const before = await readFile(target);
  const original = bindSourceBlob(before, nativePatch.upstream);
  const canonical = Buffer.from(before.toString("utf8").replaceAll("\r\n", "\n"));
  assert.equal(bindSourceBlob(canonical, nativePatch.upstream).exportTransform, "none");
  await writeFile(target, canonical);
  const args = ["-c", "core.autocrlf=false", "apply", "--whitespace=error"];
  const options = { cwd: sourceRoot, timeout: 30000, stdio: "pipe" };
  execFileSync("git", [...args, "--check", path.resolve(patchFile)], options);
  execFileSync("git", [...args, path.resolve(patchFile)], options);
  const after = await readFile(target);
  bindNativeSource(after, nativePatch.upstream, nativePatch.file);
  return { ...nativePatch, original, originalSha256: digest(before) };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await applyNativePatch("/src", "/opt/native/7z-pack-streams.patch");
  await writeFile("/opt/native/source-patch.json", `${JSON.stringify(result, null, 2)}\n`, {
    flag: "wx",
  });
}
