import assert from "node:assert/strict";
import { test } from "node:test";
import { withinZipBudget } from "../scanner/limits.mjs";
import { artZip } from "../scripts/art-package-zip.mjs";
import { changed, packageBytes } from "./art-package-fixture.mjs";

test("扫描资源预算只接受有界完整 ZIP；超大条目不依赖 ClamAV 跳过告警", () => {
  for (const method of [0, 8])
    assert.equal(withinZipBudget(packageBytes(undefined, { method })), true);
  const zip = packageBytes();
  const ascii = changed(zip, (bytes, records) => {
    for (const record of records) {
      bytes.writeUInt16LE(0, record.local + 6);
      bytes.writeUInt16LE(0, record.central + 8);
    }
  });
  assert.equal(withinZipBudget(ascii), true);
  const invalid = [
    Buffer.from("not a zip"),
    Buffer.concat([zip, Buffer.from("trailing")]),
    artZip([{ path: "large.bin", bytes: Buffer.alloc(9 * 1024 * 1024) }], 8),
    artZip(
      Array.from({ length: 34 }, (_, index) => ({
        path: `entry-${index}`,
        bytes: Buffer.from("safe"),
      })),
    ),
    changed(zip, (bytes, records) => bytes.writeUInt32LE(1, records[1].central + 42)),
    changed(zip, (bytes, records) => bytes.writeUInt16LE(1, records[0].central + 8)),
    changed(zip, (bytes, records) => bytes.writeUInt32LE(1000000, records[0].central + 20)),
  ];
  for (const bytes of invalid) assert.equal(withinZipBudget(bytes), false);
});

test("任意短/截断输入不越界；扫描前置检查不是 Art 完整格式验证", () => {
  const zip = packageBytes();
  for (let length = 0; length < zip.length; length++)
    assert.equal(withinZipBudget(zip.subarray(0, length)), false);
  assert.equal(
    withinZipBudget(artZip([{ path: "arbitrary.bin", bytes: Buffer.from("harmless") }])),
    true,
  );
});
