import assert from "node:assert/strict";
import { test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { coreModules } from "./distribution-fixture.mjs";

const json = (path, body) => ({ path, bytes: Buffer.from(JSON.stringify(body, null, 2)) });
const capability = () => [
  { path: "runtime/main.exe", bytes: Buffer.from("fixture bytes, never executed") },
  json("capability.manifest.json", { schemaVersion: 1, kind: "capability" }),
  { path: "signature.ed25519", bytes: Buffer.from("fixture, not a valid signature") },
];
const art = () => [
  { path: "runtime/main.ps1", bytes: Buffer.from("Write-Output 'fixture'") },
  json("art.runtime.json", { command: "powershell.exe" }),
  json("manifest.json", { execution: { type: "framework_art", framework: "process" } }),
];

test("原生两类 ZIP 接受非首位的原始清单，原包字节保持不变，不授予宿主信任", async () => {
  const { inspectLoomPackage } = await coreModules();
  for (const [kind, files] of [
    ["capability", capability()],
    ["art", art()],
  ]) {
    const bytes = artZip(files, 8);
    const original = Buffer.from(bytes);
    const result = await inspectLoomPackage(bytes, kind);
    assert.equal(result.schema, "loom-native-zip-v1");
    assert.equal(result.kind, kind);
    assert.deepEqual(
      result.files.map((file) => file.path),
      files.map((file) => file.path),
    );
    assert.deepEqual(bytes, original);
    assert.equal(result.trusted, undefined);
    assert.equal(result.installable, undefined);
  }
});

test("原生包拒绝类型混装、素材清单、缺少运行清单、错误编码和穿越", async () => {
  const { inspectLoomPackage } = await coreModules();
  for (const [kind, files, error] of [
    ["capability", [...capability(), json("manifest.json", {})], "PACKAGE_LAYOUT_INVALID"],
    ["capability", [...capability(), json("MANIFEST.JSON", {})], "PACKAGE_LAYOUT_INVALID"],
    ["capability", [...capability(), json("art.runtime.json", {})], "PACKAGE_LAYOUT_INVALID"],
    [
      "capability",
      [...capability(), { path: "runtime\\legacy.exe", bytes: Buffer.from("x") }],
      "ZIP_PATH_INVALID",
    ],
    ["art", capability(), "PACKAGE_LAYOUT_INVALID"],
    ["art", art().filter((entry) => entry.path !== "art.runtime.json"), "PACKAGE_LAYOUT_INVALID"],
    [
      "art",
      [art()[0], art()[1], json("manifest.json", { schema: "neuro-art-package-v1" })],
      "PACKAGE_MANIFEST_INVALID",
    ],
    [
      "capability",
      [capability()[0], { path: "capability.manifest.json", bytes: Buffer.from([255]) }],
      "PACKAGE_MANIFEST_INVALID",
    ],
    [
      "capability",
      [...capability(), { path: "../escape", bytes: Buffer.from("x") }],
      "ZIP_PATH_INVALID",
    ],
    [
      "capability",
      [...capability(), { path: "runtime/MAIN.exe", bytes: Buffer.from("x") }],
      "ZIP_PATH_COLLISION",
    ],
  ]) {
    await assert.rejects(inspectLoomPackage(artZip(files, 0), kind), (e) => e.message === error);
  }
});

test("原生布局不放宽旧素材格式与 1 MiB 单文件限制", async () => {
  const { inspectLoomPackage, inspectArtPackage } = await coreModules();
  await assert.rejects(inspectArtPackage(artZip(art(), 0)), /PACKAGE_LAYOUT_INVALID/);
  const files = capability();
  files[0].bytes = Buffer.alloc(1048577, 1);
  await assert.rejects(inspectLoomPackage(artZip(files, 0), "capability"), /ZIP_EXPANSION_LIMIT/);
});
