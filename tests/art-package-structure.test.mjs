import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import {
  both16,
  both32,
  changed,
  images,
  inspectPackage,
  packageBytes,
  startPackage,
} from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { png, prepared } from "./inspection-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});
async function rejects(bytes, error) {
  await inspectPackage(f, bytes, "rejected", error);
}

test("ZIP 路径穿越、设备名、分隔符、过长/深路径及非 ASCII 不会被修正", async () => {
  for (const path of [
    "../escape.png",
    "/root.png",
    "C:/x.png",
    "a\\x.png",
    "a//x.png",
    "a./x.png",
    "CON.png",
    "dir/Lpt9.png",
    "a/b/c/d/e.png",
    `${"a".repeat(65)}.png`,
    "图.png",
    "\ufeffx.png",
  ]) {
    await rejects(packageBytes([{ path, bytes: png() }]), "ZIP_PATH_INVALID");
  }
});

test("ZIP 大小写碰撞与文件/目录祖先冲突、清单不是首条目均拒绝", async () => {
  for (const paths of [
    ["a.png", "A.PNG"],
    ["a.png", "a.png/child.png"],
    ["a.png/child.png", "a.png"],
  ]) {
    await rejects(
      packageBytes(paths.map((path) => ({ path, bytes: png() }))),
      "ZIP_PATH_COLLISION",
    );
  }
  await rejects(
    artZip([
      { path: "first.png", bytes: png() },
      { path: "manifest.json", bytes: Buffer.from("{}") },
    ]),
    "PACKAGE_LAYOUT_INVALID",
  );
  await rejects(
    packageBytes([{ path: "script.js", bytes: Buffer.from("code") }]),
    "PACKAGE_LAYOUT_INVALID",
  );
});

test("ZIP 禁止 descriptor/加密/extra/comments/ZIP64/多卷及目录、symlink、执行权限", async () => {
  const bytes = packageBytes();
  const cases = [
    [(b) => b.writeUInt16LE(1, b.length - 18), "ZIP_STRUCTURE_INVALID"],
    [(b) => b.writeUInt16LE(1, b.length - 2), "ZIP_STRUCTURE_INVALID"],
    [(b, r) => both16(b, r[1], 6, 8, 0x808), "ZIP_FEATURE_UNSUPPORTED"],
    [(b, r) => both16(b, r[1], 6, 8, 0x801), "ZIP_FEATURE_UNSUPPORTED"],
    [(b, r) => both16(b, r[1], 4, 6, 45), "ZIP_FEATURE_UNSUPPORTED"],
    [(b, r) => b.writeUInt16LE(1, r[1].central + 30), "ZIP_FEATURE_UNSUPPORTED"],
    [(b, r) => b.writeUInt16LE(1, r[1].central + 32), "ZIP_FEATURE_UNSUPPORTED"],
    [(b, r) => b.writeUInt16LE(1, r[1].central + 34), "ZIP_FEATURE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0xa1a40000, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0x81ed0000, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0x89a40000, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0x81a40010, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0x00000008, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0x00000040, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt32LE(0x21a40000, r[1].central + 38), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt16LE(0x14, r[1].central + 4), "ZIP_FILE_TYPE_UNSUPPORTED"],
    [(b, r) => b.writeUInt16LE(0x614, r[1].central + 4), "ZIP_FILE_TYPE_UNSUPPORTED"],
  ];
  for (const [change, error] of cases) await rejects(changed(bytes, change), error);
});

test("ZIP local/central 字段、重复/重叠 offset、前缀尾部与孤立记录失败关闭", async () => {
  const bytes = packageBytes();
  for (const change of [
    (b, r) => b.writeUInt16LE(8, r[1].local + 8),
    (b, r) => b.writeUInt16LE(1, r[1].local + 10),
    (b, r) => b.writeUInt16LE(1, r[1].local + 28),
    (b, r) => b.writeUInt32LE(0, r[1].local + 14),
    (b, r) => b.writeUInt32LE(r[0].local, r[1].central + 42),
    (b, r) => b.writeUInt32LE(r[1].local + 1, r[1].central + 42),
    (b, r) => (b[r[1].local + 30] ^= 1),
    (b, r) => both32(b, r[1], 18, 20, r[1].size + 1),
    (b) => b.writeUInt32LE(1, b.length - 6),
  ])
    await rejects(changed(bytes, change), "ZIP_STRUCTURE_INVALID");
  await rejects(Buffer.concat([Buffer.from("MZ"), bytes]), "ZIP_STRUCTURE_INVALID");
  await rejects(Buffer.concat([bytes, Buffer.from("tail")]), "ZIP_STRUCTURE_INVALID");
  const orphan = changed(bytes, (b, r) => {
    b.writeUInt16LE(2, b.length - 14);
    b.writeUInt16LE(2, b.length - 12);
    b.writeUInt32LE(r[2].central - r[0].central, b.length - 10);
  });
  await rejects(orphan, "ZIP_STRUCTURE_INVALID");
});

test("ZIP CRC 与单项、清单、总解包字节和膨胀比绝对预算前置拒绝", async () => {
  const bytes = packageBytes();
  await rejects(
    changed(bytes, (b, r) => (b[r[1].data] ^= 1)),
    "ZIP_CRC_INVALID",
  );
  await rejects(
    changed(bytes, (b, r) => both32(b, r[0], 22, 24, 32769)),
    "ZIP_EXPANSION_LIMIT",
  );
  await rejects(
    changed(bytes, (b, r) => both32(b, r[1], 22, 24, 1048577)),
    "ZIP_EXPANSION_LIMIT",
  );
  await rejects(
    changed(packageBytes(images(), { method: 8 }), (b, r) => both32(b, r[1], 22, 24, 1000000)),
    "ZIP_EXPANSION_LIMIT",
  );
  const nine = packageBytes(
    Array.from({ length: 9 }, (_, i) => ({ path: `${i}.png`, bytes: Buffer.alloc(1048576) })),
  );
  const oversized = await prepared(f, nine);
  assert.equal((await startPackage(f, oversized)).body.error, "INSPECTION_SIZE_UNSUPPORTED");
  const declared = packageBytes(
    Array.from({ length: 8 }, (_, i) => ({ path: `${i}.png`, bytes: randomBytes(20000) })),
    { method: 8 },
  );
  await rejects(
    changed(declared, (b, records) => {
      for (const record of records.slice(1)) both32(b, record, 22, 24, 1048576);
    }),
    "ZIP_EXPANSION_LIMIT",
  );
});
