import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const gitBlob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

/** Windows Git archive 可按 text=auto 导出 CRLF；保留实际字节身份，只允许精确可逆的行结束转换。 */
export function bindSourceBlob(bytes, expected) {
  const rawGitBlob = gitBlob(bytes);
  if (rawGitBlob === expected) return { gitBlob: expected, rawGitBlob, exportTransform: "none" };
  const canonical = Buffer.allocUnsafe(bytes.length);
  let length = 0;
  for (let index = 0; index < bytes.length; index++) {
    if (bytes[index] === 13 && bytes[index + 1] === 10) continue;
    canonical[length++] = bytes[index];
  }
  assert.equal(gitBlob(canonical.subarray(0, length)), expected, "SOURCE_BLOB_MISMATCH");
  return { gitBlob: expected, rawGitBlob, exportTransform: "windows-git-archive-crlf" };
}

/** 固定上游 .gitattributes 仅 export-ignore 两类 Git 元数据；生成的 libnull.a 单独记账。 */
export function sourceExportLayout(tree, actual) {
  const omitted = tree.filter((entry) => /(?:^|\/)\.(?:gitattributes|gitignore)$/.test(entry.path));
  const exported = tree.filter((entry) => !omitted.includes(entry));
  const generated = actual.filter((file) => file === "libnull.a");
  assert.deepEqual(
    actual.filter((file) => !generated.includes(file)).sort(),
    exported.map((entry) => entry.path).sort(),
    "SOURCE_EXPORT_SET_MISMATCH",
  );
  return { exported, omitted, generated };
}
