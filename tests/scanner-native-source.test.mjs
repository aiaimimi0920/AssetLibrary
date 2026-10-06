import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { bindSourceBlob, sourceExportLayout } from "../scanner/native-build/source-exports.mjs";

const blob = (bytes) =>
  createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");

test("archive 仅允许省略 Git 元数据，并单独识别 libnull.a 生成物", () => {
  const tree = [".gitattributes", "sub/.gitignore", "libclamav/scan.c"].map((path) => ({ path }));
  const result = sourceExportLayout(tree, ["libnull.a", "libclamav/scan.c"]);
  assert.deepEqual(
    result.exported.map((entry) => entry.path),
    ["libclamav/scan.c"],
  );
  assert.equal(result.omitted.length, 2);
  assert.deepEqual(result.generated, ["libnull.a"]);
});

test("省略生产源码或增加未知构建源码均拒绝", () => {
  const tree = [{ path: "libclamav/scan.c" }];
  for (const actual of [[], ["libclamav/scan.c", "unknown.c"]])
    assert.throws(() => sourceExportLayout(tree, actual), /SOURCE_EXPORT_SET_MISMATCH/);
});

test("未转换 archive 保留原始 Git blob 和字节身份", () => {
  const bytes = Buffer.from("扫描\nline\r\n", "utf8");
  assert.deepEqual(bindSourceBlob(bytes, blob(bytes)), {
    gitBlob: blob(bytes),
    rawGitBlob: blob(bytes),
    exportTransform: "none",
  });
});

test("Windows CRLF 转换必须精确匹配 canonical Git blob，原始身份仍保留", () => {
  const canonical = Buffer.from([0xff, 10, 0x80, 13, 0x81, 10]);
  const exported = Buffer.from([0xff, 13, 10, 0x80, 13, 0x81, 13, 10]);
  assert.deepEqual(bindSourceBlob(exported, blob(canonical)), {
    gitBlob: blob(canonical),
    rawGitBlob: blob(exported),
    exportTransform: "windows-git-archive-crlf",
  });
});

test("内容漂移不能借行结束规范化通过，也不能丢弃独立 CR 字节", () => {
  const canonical = Buffer.from("line\n");
  for (const bytes of [Buffer.from("changed\r\n"), Buffer.from("li\rne\r\n")])
    assert.throws(() => bindSourceBlob(bytes, blob(canonical)), /SOURCE_BLOB_MISMATCH/);
});

test("断网编译 timeout 必须由 tini 托管，避免 PID 1 下超时失效", async () => {
  const dockerfile = await readFile(
    new URL("../scanner/native-build/Dockerfile", import.meta.url),
    "utf8",
  );
  assert.match(dockerfile, /RUN --network=none \/sbin\/tini -g -- timeout -s KILL 1800 sh -c/);
});
