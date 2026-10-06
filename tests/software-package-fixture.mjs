import assert from "node:assert/strict";
import { artZip } from "../scripts/art-package-zip.mjs";
import { startPackage } from "./art-package-fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { cleanFact, jsonFact, runScanner } from "./scanner-fixture.mjs";
import { sha256 } from "./upload-fixture.mjs";

export const softwarePolicy = (kind) => `${kind}-zip-clamav-v1`;
export const softwareFiles = () => [
  {
    path: "runtime/main.js",
    bytes: Buffer.from('export const message = "示例载荷，不自动执行";\n'),
  },
  { path: "data/seed.bin", bytes: Buffer.from([0, 255, 1, 128, 2, 127]) },
];
export function softwareManifest(kind, files) {
  return {
    schema: "neuro-software-package-v1",
    kind,
    files: files.map(({ path, bytes }) => ({ path, size: bytes.length, sha256: sha256(bytes) })),
  };
}
export function softwareBytes(kind, { files = softwareFiles(), manifest, method = 0 } = {}) {
  const text = manifest ?? JSON.stringify(softwareManifest(kind, files));
  return artZip([{ path: "manifest.json", bytes: Buffer.from(text) }, ...files], method);
}
export async function queueSoftware(f, kind, bytes = softwareBytes(kind)) {
  const upload = await prepared(f, bytes, kind);
  const response = await startPackage(f, upload, softwarePolicy(kind));
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return upload;
}
/** 合成 AV 只验证内部调用绑定；ZIP、清单和实际包体仍走原生产检查实现。 */
export async function checkedSoftware(f, kind, bytes = softwareBytes(kind)) {
  const upload = await queueSoftware(f, kind, bytes);
  const calls = [];
  await runScanner(f, {
    async fetch(request) {
      calls.push(Buffer.from(await request.arrayBuffer()));
      assert.equal(request.headers.get("x-object-sha256"), upload.sha256);
      return jsonFact(cleanFact(upload));
    },
  });
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, "passed", JSON.stringify(checked));
  assert.deepEqual(calls, [bytes]);
  return { upload, checked, bytes };
}
