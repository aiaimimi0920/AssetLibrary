import { after, before, test } from "node:test";
import { deflateRawSync } from "node:zlib";
import {
  both32,
  changed,
  images,
  inspectPackage,
  manifestFor,
  packageBytes,
  replaceCompressed,
} from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { png } from "./inspection-fixture.mjs";

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

test("清单字段、漏报/夹带、重复 key、BOM/UTF8 与非规范 JSON 拒绝", async () => {
  const files = images();
  const body = manifestFor(files);
  for (const [manifest, error] of [
    ["{}", "PACKAGE_MANIFEST_INVALID"],
    [JSON.stringify({ ...body, schema: "unknown" }), "PACKAGE_MANIFEST_INVALID"],
    [JSON.stringify({ ...body, files: body.files.slice(0, 1) }), "PACKAGE_MANIFEST_INVALID"],
    [
      JSON.stringify({ ...body, files: [...body.files, body.files[0]] }),
      "PACKAGE_MANIFEST_INVALID",
    ],
    [JSON.stringify({ ...body, extra: true }), "PACKAGE_MANIFEST_INVALID"],
    [`{"schema":"wrong",${JSON.stringify(body).slice(1)}`, "PACKAGE_MANIFEST_NONCANONICAL"],
    [JSON.stringify(body, null, 2), "PACKAGE_MANIFEST_NONCANONICAL"],
    [`\ufeff${JSON.stringify(body)}`, "PACKAGE_MANIFEST_INVALID"],
    [Buffer.from([0xff, 0xfe]), "PACKAGE_MANIFEST_INVALID"],
    [
      JSON.stringify({ ...body, files: body.files.map((file) => ({ ...file, extra: true })) }),
      "PACKAGE_MANIFEST_INVALID",
    ],
  ])
    await rejects(packageBytes(files, { manifest }), error);
});

test("清单顺序/path/size/mediaType/SHA-256 必须对应实际文件，扩展名不能掩盖内容", async () => {
  const files = images();
  for (const changes of [
    { path: "other.png" },
    { size: 1 },
    { size: "68" },
    { mediaType: "text/plain" },
    { sha256: "invalid" },
  ]) {
    const manifest = manifestFor(files);
    Object.assign(manifest.files[0], changes);
    await rejects(
      packageBytes(files, { manifest: JSON.stringify(manifest) }),
      "PACKAGE_MANIFEST_MISMATCH",
    );
  }
  const wrongHash = manifestFor(files);
  wrongHash.files[0].sha256 = "0".repeat(64);
  await rejects(
    packageBytes(files, { manifest: JSON.stringify(wrongHash) }),
    "PACKAGE_FILE_DIGEST_MISMATCH",
  );
  const reverse = manifestFor(files);
  reverse.files.reverse();
  await rejects(
    packageBytes(files, { manifest: JSON.stringify(reverse) }),
    "PACKAGE_MANIFEST_MISMATCH",
  );
  await rejects(
    packageBytes([{ path: "fake.png", bytes: Buffer.from("MZ not an image") }]),
    "PNG_SIGNATURE_INVALID",
  );
  const broken = png();
  broken[broken.length - 1] ^= 1;
  await rejects(packageBytes([{ path: "broken.png", bytes: broken }]), "PNG_CRC_INVALID");
});

test("真实 workerd raw-deflate：截断、尾随字节、第二压缩流均拒绝，不依赖头部失败", async () => {
  const bytes = packageBytes(images(), { method: 8 });
  for (const transform of [
    (data) => data.subarray(0, -1),
    (data) => Buffer.concat([data, Buffer.from("hidden trailing payload")]),
    (data) => Buffer.concat([data, deflateRawSync(Buffer.from("second stream"))]),
  ])
    await rejects(replaceCompressed(bytes, 1, transform), "ZIP_DEFLATE_INVALID");
});

test("raw-deflate 实际输出不得小于或超过声明，伪造小声明的炸弹不会无限解包", async () => {
  const bytes = packageBytes(images(), { method: 8 });
  for (const difference of [-1, 1]) {
    await rejects(
      changed(bytes, (b, r) =>
        both32(b, r[0], 22, 24, b.readUInt32LE(r[0].local + 22) + difference),
      ),
      "ZIP_DECODE_SIZE_MISMATCH",
    );
  }
  await rejects(
    replaceCompressed(bytes, 0, () => deflateRawSync(Buffer.alloc(2 * 1024 * 1024))),
    "ZIP_DECODE_SIZE_MISMATCH",
  );
});
