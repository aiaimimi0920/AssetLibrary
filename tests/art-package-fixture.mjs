import assert from "node:assert/strict";
import { artZip } from "../scripts/art-package-zip.mjs";
import { png, prepared, read } from "./inspection-fixture.mjs";
import { sha256, tick } from "./upload-fixture.mjs";

export const packagePolicy = "art-zip-manifest-v1";
export const imagePolicy = "art-png-rgba8-v1";
export const images = () => [
  { path: "sprites/hero.png", bytes: png() },
  { path: "sprites/enemy.png", bytes: png(2, 1) },
];
export function manifestFor(files) {
  return {
    schema: "neuro-art-package-v1",
    files: files.map(({ path, bytes }) => ({
      path,
      size: bytes.length,
      sha256: sha256(bytes),
      mediaType: "image/png",
    })),
  };
}
export function packageBytes(files = images(), { method = 0, manifest } = {}) {
  const text = manifest ?? JSON.stringify(manifestFor(files));
  return artZip([{ path: "manifest.json", bytes: Buffer.from(text) }, ...files], method);
}
export function startPackage(f, upload, policy = packagePolicy, options = {}) {
  return f.request("POST", `/v1/uploads/${upload.id}/inspection`, { policy }, options);
}
export async function inspectPackage(f, bytes, expected = "passed", error) {
  const upload = await prepared(f, bytes);
  assert.equal((await startPackage(f, upload)).status, 201);
  await tick(f);
  const result = (await read(f, upload)).body;
  assert.equal(result.state, expected, error ?? JSON.stringify(result));
  if (error) assert.equal(result.error, error);
  assert.equal(result.publicationEligible, false);
  if (expected !== "passed") assert.equal(result.result, null);
  return { upload, result };
}

export function zipRecords(bytes) {
  const end = bytes.length - 22;
  let central = bytes.readUInt32LE(end + 16);
  const records = [];
  for (let i = 0; i < bytes.readUInt16LE(end + 10); i++) {
    const local = bytes.readUInt32LE(central + 42);
    const data = local + 30 + bytes.readUInt16LE(local + 26);
    const size = bytes.readUInt32LE(central + 20);
    records.push({ central, local, data, size });
    central += 46 + bytes.readUInt16LE(central + 28);
  }
  return records;
}
export function changed(bytes, change) {
  const copy = Buffer.from(bytes);
  change(copy, zipRecords(copy));
  return copy;
}
export function both32(bytes, record, localAt, centralAt, value) {
  bytes.writeUInt32LE(value >>> 0, record.local + localAt);
  bytes.writeUInt32LE(value >>> 0, record.central + centralAt);
}
export function both16(bytes, record, localAt, centralAt, value) {
  bytes.writeUInt16LE(value, record.local + localAt);
  bytes.writeUInt16LE(value, record.central + centralAt);
}

/** 只替换压缩流并正确重算 ZIP 布局，以区分流语义失败和头部格式失败。 */
export function replaceCompressed(bytes, index, transform) {
  const records = zipRecords(bytes);
  const target = records[index];
  const data = transform(bytes.subarray(target.data, target.data + target.size));
  const delta = data.length - target.size;
  const output = Buffer.concat([
    bytes.subarray(0, target.data),
    data,
    bytes.subarray(target.data + target.size),
  ]);
  output.writeUInt32LE(data.length, target.local + 18);
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const central = record.central + delta;
    if (i === index) output.writeUInt32LE(data.length, central + 20);
    if (i > index) output.writeUInt32LE(record.local + delta, central + 42);
  }
  const end = output.length - 22;
  output.writeUInt32LE(bytes.readUInt32LE(bytes.length - 6) + delta, end + 16);
  return output;
}
