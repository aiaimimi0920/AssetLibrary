import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyInstalledEngine } from "./scanner-native-installation.mjs";
import { assessScannerRelease, sha256, trivyWindowsSha256 } from "./scanner-release-policy.mjs";

export async function readJson(filename, maxBytes = 33554432) {
  assert((await stat(filename)).size <= maxBytes, "RELEASE_INPUT_TOO_LARGE");
  return JSON.parse(await readFile(filename, "utf8"));
}

export async function loadRelease(directory) {
  const receipt = await readJson(path.join(directory, "scanner/release.json"));
  assert.equal(receipt.format, 1, "RELEASE_FORMAT_INVALID");
  assert.equal(
    receipt.scanCommand.executableSha256,
    trivyWindowsSha256,
    "RELEASE_SCANNER_MISMATCH",
  );
  assert.equal(receipt.scanCommand.noIgnoreUnfixed, true, "FILTERED_REPORT_FORBIDDEN");
  for (const required of [
    "manifest.json",
    "scanner/runtime-validation.json",
    "scanner/cleanup.json",
    "scanner/image-build.log",
    "scanner/vulnerabilities.json",
    "scanner/vulnerability-database.json",
    "scanner/vulnerability-scan.log",
    "scanner/trivy-empty.yaml",
    "scanner/trivy-empty.ignore",
  ])
    assert(/^[0-9a-f]{64}$/.test(receipt.files?.[required]), "RELEASE_EVIDENCE_MISSING");
  assert.equal(
    receipt.files["manifest.json"],
    sha256(await readFile(path.join(directory, "manifest.json"))),
    "MANIFEST_CHANGED",
  );
  for (const [relative, digest] of Object.entries(receipt.files)) {
    assert(
      !path.isAbsolute(relative) && !relative.includes("..") && !relative.includes(":"),
      "RELEASE_PATH_INVALID",
    );
    assert.equal(
      sha256(await readFile(path.join(directory, relative))),
      digest,
      `RELEASE_FILE_CHANGED:${relative}`,
    );
  }
  const manifest = await readJson(path.join(directory, "manifest.json"));
  for (const [relative, digest] of Object.entries(manifest.artifacts)) {
    assert(
      !path.isAbsolute(relative) && !relative.includes("..") && !relative.includes(":"),
      "ARTIFACT_PATH_INVALID",
    );
    assert.equal(
      sha256(await readFile(path.join(directory, relative))),
      digest,
      `ARTIFACT_CHANGED:${relative}`,
    );
  }
  const runtime = await readJson(path.join(directory, "scanner/runtime-validation.json"));
  if (manifest.artifacts["scanner/native-install.json"]) {
    const native = await readJson(path.join(directory, "scanner/native-install.json"));
    assert.match(native.nativeReceiptSha256, /^[0-9a-f]{64}$/, "NATIVE_ORIGIN_RECEIPT_MISSING");
    assert.equal(
      sha256(await readFile(path.join(directory, "scanner/install.tar"))),
      native.installSha256,
      "NATIVE_INSTALL_CHANGED",
    );
    verifyInstalledEngine(native.installed, runtime.actual?.engine ?? {});
  }
  const cleanup = await readJson(path.join(directory, "scanner/cleanup.json"));
  assert.equal(cleanup.removed, true, "OWNED_CONTAINER_NOT_REMOVED");
  assert.equal(cleanup.imageRetained, runtime.image.id, "CLEANUP_IMAGE_MISMATCH");
  for (const name of ["database.mjs", "process.mjs", "server.mjs", "limits.mjs"]) {
    assert(/^[0-9a-f]{64}$/.test(runtime.actual?.files?.[name]), "RUNTIME_SOURCE_MISSING");
    assert.equal(
      manifest.artifacts[`scanner/${name}`],
      runtime.actual.files[name],
      "RUNTIME_SOURCE_MISMATCH",
    );
  }
  return {
    runtime,
    report: await readJson(path.join(directory, "scanner/vulnerabilities.json")),
    vulnerabilityDatabase: await readJson(
      path.join(directory, "scanner/vulnerability-database.json"),
    ),
  };
}

export async function assessCandidate(directory, previousDirectory, now = Date.now()) {
  const input = await loadRelease(directory);
  if (previousDirectory)
    input.previous = (await loadRelease(previousDirectory)).runtime.actual.database;
  return assessScannerRelease(input, now);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [candidate, previous, ...extra] = process.argv.slice(2);
  assert(candidate && !extra.length, "USAGE: scanner:assess <candidate> [current-candidate]");
  const result = await assessCandidate(candidate, previous);
  console.log(
    JSON.stringify(
      { ...result, vulnerabilities: { counts: result.vulnerabilities.counts } },
      null,
      2,
    ),
  );
  process.exitCode = result.candidateEligible ? 0 : 2;
}
