import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, test } from "node:test";
import { packSoftware } from "../scripts/pack-software.mjs";
import { artifactRoot } from "../scripts/source-scope.mjs";
import { startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { tick } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => f?.dispose());

test("大型应用打包显式启用且不扩大旧策略；高压缩比文件改用 Stored", async () => {
  const input = await mkdtemp(path.join(artifactRoot, "large-pack-input-"));
  await writeFile(path.join(input, "payload.bin"), Buffer.alloc(2 * 1024 * 1024, 37));
  const recipe = { kind: "application", files: ["payload.bin"] };
  await writeFile(path.join(input, "software-package.json"), JSON.stringify(recipe));
  await assert.rejects(packSoftware(input), /PACKAGE_INPUT_SIZE_LIMIT/);
  const result = await packSoftware(input, { largeApplication: true });
  assert.equal(result.policy, "application-large-zip-format-v1");
  const bytes = await readFile(path.join(result.output, "package.zip"));
  assert.ok(bytes.length > 2 * 1024 * 1024);
  const upload = await prepared(f, bytes, "application");
  assert.equal((await startPackage(f, upload, result.policy)).status, 201);
  await tick(f);
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, "passed", JSON.stringify(checked));
  assert.equal(checked.result.scanStatus, "not_scanned");
  recipe.kind = "mcp";
  await writeFile(path.join(input, "software-package.json"), JSON.stringify(recipe));
  await assert.rejects(packSoftware(input, { largeApplication: true }), /PACKAGE_RECIPE_INVALID/);
});

test("指定完整 Loom 包经真实 Worker/R2 流式检查", {
  skip: !process.env.LOOM_LARGE_PACKAGE,
}, async () => {
  const bytes = await readFile(process.env.LOOM_LARGE_PACKAGE);
  const upload = await prepared(f, bytes, "application");
  assert.equal((await startPackage(f, upload, "application-large-zip-format-v1")).status, 201);
  await tick(f);
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, "passed", JSON.stringify(checked));
  assert.ok(checked.result.files.some((file) => file.path === "Loom.exe"));
  assert.ok(checked.result.files.some((file) => file.path === "runtime/loom-daemon.exe"));
  assert.equal(checked.result.scanStatus, "not_scanned");
});
