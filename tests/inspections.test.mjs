import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { deflateSync } from "node:zlib";
import { fixture } from "./fixture.mjs";
import { chunk, header, png, prepared, read, signature, start } from "./inspection-fixture.mjs";
import { cancel, keyOf, reserve, tick } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});

test("真实 Worker/D1/R2：PNG 排队、原生 scheduled 检查与事实查询，仍不能发布下载", async () => {
  const upload = await prepared(f);
  const queued = await start(f, upload);
  assert.equal(queued.status, 201);
  assert.equal(queued.body.state, "queued");
  assert.equal(queued.body.attempts, 0);
  await tick(f);
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, "passed");
  assert.equal(checked.attempts, 1);
  assert.equal(checked.bindingCurrent, true);
  assert.equal(checked.result.sha256, upload.sha256);
  assert.equal(checked.result.width, 1);
  assert.equal(checked.result.height, 1);
  assert.equal(checked.result.decodedBytes, 5);
  assert.equal(checked.publicationEligible, false);
  assert.equal(
    (await f.request("POST", `/v1/resources/${upload.resourceId}/publish`, {})).status,
    404,
  );
  assert.equal((await f.request("GET", `/v1/uploads/${upload.id}/download`)).status, 404);
  assert.equal((await f.request("GET", `/v1/uploads/${upload.id}`)).body.state, "quarantined");
  assert.ok(await f.bucket.head(keyOf(upload)));
  const again = await start(f, upload);
  assert.equal(again.status, 200);
  assert.equal(again.body.id, checked.id);
  assert.equal(again.body.revision, checked.revision);
});

test("检查仅归 owner；成员、伪造状态、未完成、大对象与其他资源类型失败关闭", async () => {
  const upload = await prepared(f);
  await start(f, upload);
  await f.request("PUT", `/v1/resources/${upload.resourceId}/members/user:bob`, { revision: 1 });
  for (const principal of ["user:bob", "user:eve"]) {
    assert.equal((await start(f, upload, { principal })).status, 404);
    assert.equal((await read(f, upload, { principal })).status, 404);
  }
  assert.equal(
    (await f.request("POST", `/v1/uploads/${upload.id}/inspection`, { state: "passed" })).status,
    400,
  );
  assert.equal((await start(f, upload, { token: "invalid" })).status, 401);
  assert.equal((await start(f, await reserve(f))).status, 409);
  assert.equal(
    (await start(f, await prepared(f, Buffer.alloc(1048577)))).body.error,
    "INSPECTION_SIZE_UNSUPPORTED",
  );
  for (const kind of ["capability", "application"])
    assert.equal(
      (await start(f, await prepared(f, png(), kind))).body.error,
      "INSPECTION_POLICY_UNAVAILABLE",
    );
});

test("并发排队仅创建一份任务和一次审计；取消后的结果绑定立即失效", async () => {
  const upload = await prepared(f);
  const requests = await Promise.all(Array.from({ length: 4 }, () => start(f, upload)));
  assert.equal(requests.filter((r) => r.status === 201).length, 1);
  assert.ok(requests.every((r) => r.body.id === requests[0].body.id));
  await tick(f);
  await cancel(f, upload);
  const result = (await read(f, upload)).body;
  assert.equal(result.state, "passed");
  assert.equal(result.bindingCurrent, false);
  assert.equal(result.publicationEligible, false);
  assert.equal((await start(f, upload)).status, 409);
  const events = await f.db
    .prepare("SELECT state FROM inspection_events WHERE inspection_id = ? ORDER BY revision")
    .bind(result.id)
    .all();
  assert.deepEqual(
    events.results.map((row) => row.state),
    ["queued", "running", "passed"],
  );
});

test("不支持的格式、结构与解压炸弹产生拒绝事实，不标记为可发布", async () => {
  const corrupted = png();
  corrupted[corrupted.length - 1] ^= 1;
  const cases = [
    [Buffer.from("MZ untrusted executable"), "PNG_SIGNATURE_INVALID"],
    [corrupted, "PNG_CRC_INVALID"],
    [Buffer.concat([png(), Buffer.from("trailing")]), "PNG_CHUNKS_INVALID"],
    [
      Buffer.concat([
        signature,
        header(),
        chunk("tEXt", Buffer.from("payload")),
        chunk("IDAT", deflateSync(Buffer.alloc(5))),
        chunk("IEND"),
      ]),
      "PNG_POLICY_UNSUPPORTED",
    ],
    [
      Buffer.concat([
        signature,
        header(2049, 1),
        chunk("IDAT", deflateSync(Buffer.alloc(5))),
        chunk("IEND"),
      ]),
      "PNG_DIMENSIONS_UNSUPPORTED",
    ],
    [png(1, 1, Buffer.alloc(5, 9)), "PNG_FILTER_INVALID"],
    [png(1, 1, Buffer.alloc(4)), "PNG_DECODE_SIZE_MISMATCH"],
    [png(1, 1, Buffer.alloc(1024 * 1024)), "PNG_DECODE_SIZE_MISMATCH"],
    [
      Buffer.concat([
        signature,
        header(),
        chunk("IDAT", Buffer.from("invalid zlib")),
        chunk("IEND"),
      ]),
      "PNG_DEFLATE_INVALID",
    ],
    [
      Buffer.concat([
        signature,
        header(),
        chunk("IDAT", deflateSync(Buffer.alloc(5)).subarray(0, -1)),
        chunk("IEND"),
      ]),
      "PNG_DEFLATE_INVALID",
    ],
    [
      Buffer.concat([
        signature,
        header(),
        chunk(
          "IDAT",
          Buffer.concat([deflateSync(Buffer.alloc(5)), Buffer.from("hidden trailing bytes")]),
        ),
        chunk("IEND"),
      ]),
      "PNG_DEFLATE_INVALID",
    ],
    [
      Buffer.concat([
        signature,
        header(),
        ...Array.from({ length: 63 }, () => chunk("IDAT")),
        chunk("IEND"),
      ]),
      "PNG_CHUNKS_INVALID",
    ],
  ];
  for (const [data, error] of cases) {
    const upload = await prepared(f, data);
    await start(f, upload);
    await tick(f);
    const result = (await read(f, upload)).body;
    assert.equal(result.state, "rejected", error);
    assert.equal(result.error, error);
    assert.equal(result.result, null);
    assert.equal(result.publicationEligible, false);
    assert.equal((await f.request("GET", `/v1/uploads/${upload.id}`)).body.state, "quarantined");
  }
});

test("有界近 1 MiB 输入和最大解码像素在本地 Worker 完成，记录非 CPU 耗时", async () => {
  const width = 960;
  const height = 256;
  const data = randomBytes((width * 4 + 1) * height);
  for (let i = 0; i < data.length; i += width * 4 + 1) data[i] = 0;
  const large = png(width, height, data);
  assert.ok(large.length > 900000 && large.length <= 1048576);
  const compressed = deflateSync(Buffer.alloc(5));
  const split = Buffer.concat([
    signature,
    header(),
    ...Array.from(compressed, (byte) => chunk("IDAT", Buffer.from([byte]))),
    chunk("IEND"),
  ]);
  for (const bytes of [large, png(1024, 1024), split]) {
    const upload = await prepared(f, bytes);
    await start(f, upload);
    await tick(f);
    const result = (await read(f, upload)).body;
    assert.equal(result.state, "passed");
    assert.equal(result.result.bytesRead, bytes.length);
    assert.ok(result.result.decodedBytes <= 4196352);
    assert.ok(result.result.elapsedMs >= 0);
  }
});
