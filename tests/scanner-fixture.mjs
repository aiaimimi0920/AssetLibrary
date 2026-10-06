import assert from "node:assert/strict";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { hostWorker } from "./worker-fixture.mjs";

export const scanPolicy = "art-zip-clamav-v1";
export function cleanFact(upload, changes = {}) {
  const now = Date.now();
  return {
    protocol: "neuro-clamav-v1",
    verdict: "clean",
    sha256: upload.sha256,
    size: upload.size,
    engineVersion: "1.5.4",
    database: { sha256: "a".repeat(64), dailyVersion: 1, updatedAt: now - 1000 },
    completedAt: now,
    expiresAt: now + 3600000,
    ...changes,
  };
}
export async function queuedScan(f, bytes = packageBytes()) {
  const upload = await prepared(f, bytes);
  assert.equal((await startPackage(f, upload, scanPolicy)).status, 201);
  return upload;
}
export async function runScanner(f, scanner) {
  const worker = await hostWorker();
  await worker.scheduled({}, { ...f.env, ...(scanner ? { SCANNER: scanner } : {}) });
}
export const jsonFact = (fact) =>
  new Response(JSON.stringify(fact), { headers: { "content-type": "application/json" } });
export async function assertNotPassed(f, upload, state = "queued") {
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, state);
  assert.equal(checked.result, null);
  assert.equal(checked.publicationEligible, false);
  return checked;
}
