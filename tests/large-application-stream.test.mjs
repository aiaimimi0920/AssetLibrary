import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { changed, replaceCompressed, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { softwareBytes, softwareManifest } from "./software-package-fixture.mjs";
import { tick } from "./upload-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig, streamFaults: true });
});
after(async () => f?.dispose());
const policy = "application-large-zip-format-v1";

async function inspect(bytes, expected = "passed", error) {
  const upload = await prepared(f, bytes, "application");
  const queued = await startPackage(f, upload, policy);
  assert.equal(queued.status, 201, JSON.stringify(queued));
  await tick(f);
  const result = (await read(f, upload)).body;
  assert.equal(result.state, expected, JSON.stringify(result));
  if (error) assert.equal(result.error, error);
  return { upload, result };
}

test("80 MB 应用包真实 R2 流式检查、独立审核及未扫描发布", async () => {
  const files = [{ path: "runtime/Loom.exe", bytes: randomBytes(80_000_000) }];
  const { upload, result } = await inspect(softwareBytes("application", { files }));
  assert.equal(result.result.files[0].size, 80_000_000);
  assert.equal(result.result.scanStatus, "not_scanned");
  assert.equal(result.result.scan, undefined);
  const created = await createVersion(f, upload);
  assert.equal(created.status, 201, JSON.stringify(created));
  const approved = await review(f, created.body);
  assert.equal(approved.status, 200);
  const published = await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
    revision: approved.body.revision,
  });
  assert.equal(published.status, 201, JSON.stringify(published));
});

test("大包分支支持 Deflate 与多文件，逐文件校验清单", async () => {
  const files = Array.from({ length: 47 }, (_, i) => ({
    path: `runtime/file-${i}.bin`,
    bytes: randomBytes(1024),
  }));
  const { result } = await inspect(softwareBytes("application", { files, method: 8 }));
  assert.equal(result.result.fileCount, 47);
  assert.deepEqual(result.result.files, softwareManifest("application", files).files);
});

test("流式解析拒绝目录差异、CRC 损坏、尾随数据和错误清单摘要", async () => {
  const bytes = softwareBytes("application");
  await inspect(
    changed(bytes, (copy, entries) => copy.writeUInt32LE(99, entries[1].central + 24)),
    "rejected",
    "ZIP_STRUCTURE_INVALID",
  );
  await inspect(
    changed(bytes, (copy, entries) => {
      copy[entries[1].data] ^= 1;
    }),
    "rejected",
    "ZIP_CRC_INVALID",
  );
  await inspect(Buffer.concat([bytes, Buffer.from([1])]), "rejected", "ZIP_STRUCTURE_INVALID");
  const files = [{ path: "main.exe", bytes: randomBytes(50) }];
  const manifest = softwareManifest("application", files);
  manifest.files[0].sha256 = "a".repeat(64);
  await inspect(
    softwareBytes("application", { files, manifest: JSON.stringify(manifest) }),
    "rejected",
    "PACKAGE_FILE_DIGEST_MISMATCH",
  );
});

test("stored/deflate 载荷上游故障允许重试，损坏 Deflate 才永久拒绝", async () => {
  for (const method of [0, 8]) {
    const bytes = softwareBytes("application", {
      method,
      files: [{ path: "main.exe", bytes: randomBytes(8192) }],
    });
    const upload = await prepared(f, bytes, "application");
    assert.equal((await startPackage(f, upload, policy)).status, 201);
    const fault = await f.mf.dispatchFetch("http://localhost/test-inspection", {
      headers: { "x-test-inspection-fault": "interrupt" },
    });
    assert.equal(fault.status, 200);
    const interrupted = (await read(f, upload)).body;
    assert.equal(interrupted.state, "queued", JSON.stringify({ method, interrupted }));
    await f.db
      .prepare("UPDATE inspections SET next_attempt_at = 0 WHERE upload_id = ?")
      .bind(upload.id)
      .run();
    await tick(f);
    assert.equal((await read(f, upload)).body.state, "passed");
  }
  const invalid = replaceCompressed(softwareBytes("application", { method: 8 }), 1, () =>
    Buffer.from([0xff, 0xff, 0xff]),
  );
  await inspect(invalid, "rejected", "ZIP_DEFLATE_INVALID");
});
