import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import {
  imagePolicy,
  images,
  inspectPackage,
  packageBytes,
  packagePolicy,
  startPackage,
} from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { png, prepared, read, start } from "./inspection-fixture.mjs";
import { cancel, keyOf, tick } from "./upload-fixture.mjs";
import { createVersion, events, readVersion, review, reviewerConfig } from "./version-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
});
after(async () => {
  await f?.dispose();
});

test("多 PNG Art ZIP：Stored/Deflate → 私有检查 → 不可变版本 → 独立批准，publish 仍拒绝", async () => {
  for (const method of [0, 8]) {
    const bytes = packageBytes(images(), { method });
    const { upload, result } = await inspectPackage(f, bytes);
    assert.equal(result.policy, packagePolicy);
    assert.equal(result.result.fileCount, 2);
    assert.equal(result.result.totalPixels, 3);
    assert.equal(result.result.sha256, upload.sha256);
    assert.equal(result.result.bytesRead, bytes.length);
    assert.deepEqual(
      result.result.files.map((file) => file.path),
      images().map((file) => file.path),
    );
    assert.notEqual(result.result.files[0].sha256, result.result.sha256);
    const created = await createVersion(f, upload);
    assert.equal(created.status, 201);
    assert.equal(created.body.snapshot.inspection.policy, packagePolicy);
    assert.equal(created.body.snapshot.sha256, upload.sha256);
    const approved = await review(f, created.body);
    assert.equal(approved.status, 200);
    const published = await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
      revision: 2,
    });
    assert.equal(published.status, 409);
    assert.equal(published.body.error, "REQUIRED_CONTENT_CHECK_UNAVAILABLE");
    assert.equal((await f.request("GET", `/v1/uploads/${upload.id}`)).body.state, "quarantined");
    assert.ok(await f.bucket.head(keyOf(upload)));
    await cancel(f, upload);
    assert.equal((await readVersion(f, created.body)).body.bindingCurrent, false);
    assert.deepEqual(
      (await events(f, created.body)).map((event) => event.action),
      ["created", "approved"],
    );
  }
});

test("同一 upload 不同 policy 串行或并发不能静默重放、重置次数或重复审计", async () => {
  const upload = await prepared(f, packageBytes());
  const results = await Promise.all([startPackage(f, upload), start(f, upload)]);
  const winner = results.find((result) => result.status === 201);
  assert.ok(winner);
  assert.equal(
    results.find((result) => result.status === 409).body.error,
    "INSPECTION_POLICY_CONFLICT",
  );
  await tick(f);
  const checked = (await read(f, upload)).body;
  const otherPolicy = checked.policy === packagePolicy ? imagePolicy : packagePolicy;
  assert.equal(
    (await startPackage(f, upload, otherPolicy)).body.error,
    "INSPECTION_POLICY_CONFLICT",
  );
  assert.deepEqual((await startPackage(f, upload, checked.policy)).body, checked);
  assert.equal(checked.attempts, 1);
  const eventCount = await f.db
    .prepare("SELECT count(*) AS n FROM inspection_events WHERE inspection_id = ?")
    .bind(checked.id)
    .first();
  assert.equal(eventCount.n, 3);
  const image = await prepared(f, png());
  assert.equal((await start(f, image)).status, 201);
  assert.equal((await startPackage(f, image, imagePolicy)).status, 200);
  assert.equal((await startPackage(f, image, "unknown-v1")).status, 422);
  assert.equal(
    (await startPackage(f, image, packagePolicy, { principal: "user:eve" })).status,
    404,
  );
});

test("32 图片完整结果超过旧 2048 字节限制仍持久保存，33 图片拒绝", async () => {
  const files = Array.from({ length: 32 }, (_, index) => ({
    path: `sprites/frame-${index}.png`,
    bytes: png(),
  }));
  const { upload, result } = await inspectPackage(f, packageBytes(files));
  assert.equal(result.result.files.length, 32);
  assert.ok(JSON.stringify(result.result).length > 2048);
  assert.equal((await createVersion(f, upload)).status, 201);
  await inspectPackage(
    f,
    packageBytes([...files, { path: "extra.png", bytes: png() }]),
    "rejected",
    "ZIP_ENTRY_LIMIT",
  );
});

test("多 PNG 共 1MP 和约 4MiB 的真实归档有界通过；下一张越预算在解码前拒绝", async () => {
  const width = 1024;
  const height = 256;
  const files = Array.from({ length: 4 }, (_, index) => {
    const pixels = randomBytes((width * 4 + 1) * height);
    for (let offset = 0; offset < pixels.length; offset += width * 4 + 1) pixels[offset] = 0;
    // 避免压缩后的 PNG 超过单文件 1 MiB；仍保留接近上限的不可压缩内容。
    pixels.fill(0, pixels.length - 2048);
    return { path: `frame-${index}.png`, bytes: png(width, height, pixels) };
  });
  const bytes = packageBytes(files);
  assert.ok(bytes.length > 4_000_000);
  assert.ok(files.every((file) => file.bytes.length <= 1048576));
  const { upload, result } = await inspectPackage(f, bytes);
  assert.equal(result.result.totalPixels, 1048576);
  assert.equal((await start(f, upload)).body.error, "INSPECTION_POLICY_CONFLICT");
  assert.equal((await createVersion(f, upload)).status, 201);
  await inspectPackage(
    f,
    packageBytes([
      ...files,
      { path: "over.png", bytes: png(1, 1, Buffer.from("invalid compressed image")) },
    ]),
    "rejected",
    "PNG_PIXEL_BUDGET_EXCEEDED",
  );
});
