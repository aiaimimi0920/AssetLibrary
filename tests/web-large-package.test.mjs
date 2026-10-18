import assert from "node:assert/strict";
import test from "node:test";
import { validatePublication } from "../src/web/download.client.js";
import { browserModules } from "./web-client-fixture.mjs";

test("仅大型应用策略允许超过 8 MiB 的下载元数据", () => {
  const publication = {
    id: "11111111-1111-4111-8111-111111111111",
    versionId: "22222222-2222-4222-8222-222222222222",
    kind: "application",
    policy: "application-large-zip-format-v1",
    size: 96_000_000,
    sha256: "a".repeat(64),
  };
  assert.doesNotThrow(() => validatePublication(publication));
  for (const change of [
    { kind: "art" },
    { policy: "application-zip-format-v1" },
    { size: 96_000_001 },
  ]) {
    assert.throws(
      () => validatePublication({ ...publication, ...change }),
      /INVALID_DOWNLOAD_METADATA/,
    );
  }
});

test("大型上传超过预算在读取文件和预约之前拒绝", async () => {
  const { upload } = await browserModules();
  await assert.rejects(
    upload.uploadPackage(
      { id: "r", kind: "application" },
      { name: "large.zip", size: 96_000_001 },
      "application-large-zip-format-v1",
      new AbortController().signal,
      () => {},
    ),
    /PACKAGE_ZIP_REQUIRED_MAX_96_MB/,
  );
});
