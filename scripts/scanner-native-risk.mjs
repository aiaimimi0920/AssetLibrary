import assert from "node:assert/strict";
import { copyFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { bindSourceBlob } from "../scanner/native-build/source-exports.mjs";
import { nativeProofFiles, verifyNativeProof } from "./scanner-native-policy.mjs";
import { assessNativeRisk } from "./scanner-native-risk-policy.mjs";
import { sha256, trivyWindowsSha256 } from "./scanner-release-policy.mjs";
import { scanReleaseImage } from "./scanner-release-tools.mjs";
import { scanSourceLock } from "./scanner-source-tools.mjs";
import { artifactRoot } from "./source-scope.mjs";

const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = (file, value) =>
  writeFile(file, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });

async function evidenceFiles(output) {
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(path.join(output, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (relative === "risk-receipt.json") continue;
      assert(!entry.isSymbolicLink(), "RISK_EVIDENCE_LINK");
      if (entry.isDirectory()) await walk(relative);
      else {
        assert(entry.isFile(), "RISK_EVIDENCE_SPECIAL_FILE");
        assert((await stat(path.join(output, relative))).size <= 33554432, "RISK_EVIDENCE_SIZE");
        files[relative] = sha256(await readFile(path.join(output, relative)));
        assert(Object.keys(files).length <= 1000, "RISK_EVIDENCE_COUNT");
      }
    }
  }
  await walk("");
  return files;
}

async function nativeReceipt(native) {
  const receipt = await json(path.join(native, "receipt.json"));
  assert.deepEqual(await nativeProofFiles(native), receipt.files, "NATIVE_EVIDENCE_CHANGED");
  assert.deepEqual(
    await verifyNativeProof(native),
    receipt.verification,
    "NATIVE_ASSESSMENT_CHANGED",
  );
  return receipt;
}

/** 新扫描只读不可变镜像，重新评估只读取冻结证据；两个入口都不触发云部署或生产批准。 */
const args = process.argv.slice(2);
const assess = args[0] === "--assess";
assert(
  assess ? args.length === 3 : args.length === 4,
  "USAGE: scanner:native-risk <native> <Cargo.lock> <trivy.exe> <cache> | --assess <native> <risk-directory>",
);
const native = path.resolve(args[assess ? 1 : 0]);
const receipt = await nativeReceipt(native);
const nativeSha256 = sha256(await readFile(path.join(native, "receipt.json")));
const source = await json(path.join(native, "proof/evidence/source-files.json"));
let output;
if (assess) output = path.resolve(args[2]);
else {
  output = await mkdtemp(path.join(artifactRoot, "assetlibrary-native-risk-"));
  console.log(`Native risk evidence: ${output}`);
  await mkdir(path.join(output, "scanner"));
  await mkdir(path.join(output, "source-scan/source"), { recursive: true });
  assert((await stat(args[1])).size <= 1048576, "RISK_LOCK_SIZE");
  const bytes = await readFile(args[1]);
  const binding = bindSourceBlob(bytes, source["Cargo.lock"].gitBlob);
  const destination = path.join(output, "source-scan/source/Cargo.lock");
  await copyFile(args[1], destination);
  assert.equal(sha256(await readFile(destination)), sha256(bytes), "LOCK_COPY_CHANGED");
  const imageScan = await scanReleaseImage(
    path.resolve(args[2]),
    path.resolve(args[3]),
    output,
    receipt.image,
  );
  const sourceScan = await scanSourceLock(
    path.resolve(args[2]),
    path.resolve(args[3]),
    path.join(output, "source-scan"),
  );
  await save(path.join(output, "scan-inputs.json"), {
    native,
    image: receipt.image,
    binding,
    imageScan,
    sourceScan,
  });
}
const files = await evidenceFiles(output);
const inputs = await json(path.join(output, "scan-inputs.json"));
assert.equal(path.resolve(inputs.native), native, "RISK_NATIVE_PATH_MISMATCH");
assert.equal(inputs.image, receipt.image, "RISK_IMAGE_MISMATCH");
assert.equal(inputs.imageScan.executableSha256, trivyWindowsSha256, "RISK_IMAGE_TOOL_MISMATCH");
assert.equal(inputs.sourceScan.trivySha256, trivyWindowsSha256, "RISK_SOURCE_TOOL_MISMATCH");
for (const scan of [inputs.imageScan, inputs.sourceScan])
  assert.equal(scan.noIgnoreUnfixed, true, "RISK_FINDINGS_FILTERED");
const lockPath = path.join(output, "source-scan/source/Cargo.lock");
assert((await stat(lockPath)).size <= 1048576, "RISK_LOCK_SIZE");
const lock = await readFile(lockPath);
assert.deepEqual(
  bindSourceBlob(lock, source["Cargo.lock"].gitBlob),
  inputs.binding,
  "RISK_LOCK_CHANGED",
);
const assessment = assessNativeRisk({
  image: receipt.image,
  imageReport: await json(path.join(output, "scanner/vulnerabilities.json")),
  imageDatabase: await json(path.join(output, "scanner/vulnerability-database.json")),
  runtime: await json(path.join(native, "runtime.json")),
  metadata: await json(path.join(native, "proof/evidence/cargo-metadata.json")),
  rust: await json(path.join(native, "proof/evidence/rust-artifacts.json")),
  lock: lock.toString("utf8"),
  sourceReport: await json(path.join(output, "source-scan/vulnerabilities.json")),
  sourceDatabase: await json(path.join(output, "source-scan/vulnerability-database.json")),
});
await nativeReceipt(native);
assert.equal(
  sha256(await readFile(path.join(native, "receipt.json"))),
  nativeSha256,
  "NATIVE_RECEIPT_CHANGED",
);
assert.deepEqual(await evidenceFiles(output), files, "RISK_EVIDENCE_CHANGED_DURING_ASSESSMENT");
const target = path.join(output, "risk-receipt.json");
let existing;
try {
  existing = await json(target);
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
if (existing) {
  assert.equal(existing.nativeReceiptSha256, nativeSha256, "RISK_NATIVE_RECEIPT_CHANGED");
  assert.deepEqual(existing.files, files, "RISK_FROZEN_EVIDENCE_CHANGED");
  assert.deepEqual(existing.assessment, assessment, "RISK_ASSESSMENT_CHANGED");
} else
  await save(target, {
    format: 1,
    at: new Date().toISOString(),
    native,
    nativeReceiptSha256: nativeSha256,
    image: receipt.image,
    files,
    assessment,
    cloudMutation: false,
  });
console.log(JSON.stringify({ output, assessment }, null, 2));
// 合法完整报告也可能未取得准入；exit 2 与执行/证据错误明确区分。
process.exitCode = assessment.supplyChainValidated ? 0 : 2;
