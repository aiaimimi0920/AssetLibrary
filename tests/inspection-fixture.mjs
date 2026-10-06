import assert from "node:assert/strict";
import { deflateSync } from "node:zlib";
import { complete, put, sha256 } from "./upload-fixture.mjs";
import { hostWorker } from "./worker-fixture.mjs";

export const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export function chunk(type, data = Buffer.alloc(0)) {
  const name = Buffer.from(type);
  let crc = 0xffffffff;
  // 夹具独立用逐位 CRC，与生产表驱动实现交叉核对。
  for (const byte of Buffer.concat([name, data])) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  }
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([length, name, data, checksum]);
}
export function header(width = 1, height = 1) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width, 0);
  data.writeUInt32BE(height, 4);
  data[8] = 8;
  data[9] = 6;
  return chunk("IHDR", data);
}
export function png(width = 1, height = 1, pixels = Buffer.alloc((width * 4 + 1) * height)) {
  return Buffer.concat([
    signature,
    header(width, height),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND"),
  ]);
}

export async function prepared(f, bytes = png(), kind = "art") {
  const resource = await f.request("POST", "/v1/resources", { kind, title: "检查测试资源" });
  assert.equal(resource.status, 201);
  const reserved = await f.request("POST", `/v1/resources/${resource.body.id}/uploads`, {
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(reserved.status, 201);
  const upload = reserved.body;
  assert.equal((await put(f, upload, bytes)).status, 200);
  assert.equal((await complete(f, upload)).status, 200);
  return upload;
}
export async function start(f, upload, options = {}) {
  return f.request("POST", `/v1/uploads/${upload.id}/inspection`, {}, options);
}
export async function read(f, upload, options = {}) {
  return f.request("GET", `/v1/uploads/${upload.id}/inspection`, undefined, options);
}
export async function dueInspection(f, upload) {
  await f.db
    .prepare("UPDATE inspections SET next_attempt_at = 0, lease_until = 0 WHERE upload_id = ?")
    .bind(upload.id)
    .run();
}
export async function scheduledWithStorage(f, storage) {
  const worker = await hostWorker();
  return worker.scheduled({}, { ...f.env, QUARANTINE: storage });
}
