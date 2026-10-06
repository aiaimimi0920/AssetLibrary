import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "./build.mjs";
import { assessScannerRelease, sha256 } from "./scanner-release-policy.mjs";
import { assessCandidate, readJson } from "./scanner-release-proof.mjs";
import { scanReleaseImage, verifyTrivy } from "./scanner-release-tools.mjs";
import { root, sourceFiles } from "./source-scope.mjs";
import { verifyScanner } from "./verify-scanner.mjs";

const [trivy, cache, nativeDirectory, ...extra] = process.argv.slice(2);
assert(
  trivy && cache && !extra.length,
  "USAGE: scanner:release <trivy.exe> <cache-directory> [native-build-directory]",
);
await verifyTrivy(trivy);
const output = await build(nativeDirectory);
await verifyScanner(output);
const runtime = await readJson(path.join(output, "scanner/runtime-validation.json"));
const scanCommand = await scanReleaseImage(trivy, cache, output, runtime.image.id);
const report = await readJson(path.join(output, "scanner/vulnerabilities.json"));
const vulnerabilityDatabase = await readJson(
  path.join(output, "scanner/vulnerability-database.json"),
);
const assessment = assessScannerRelease({ runtime, report, vulnerabilityDatabase });
const manifest = await readJson(path.join(output, "manifest.json"));
// 在昂贵构建/扫描期间，若任何活动源码改变，不签发当前源码身份回执。
assert.deepEqual(Object.keys(manifest.sources), await sourceFiles(), "SOURCE_SET_CHANGED");
for (const [relative, digest] of Object.entries(manifest.sources))
  assert.equal(
    sha256(await readFile(path.join(root, relative))),
    digest,
    `SOURCE_CHANGED:${relative}`,
  );
const files = {};
for (const relative of [
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
  files[relative] = sha256(await readFile(path.join(output, relative)));
await writeFile(
  path.join(output, "scanner/release.json"),
  `${JSON.stringify(
    {
      format: 1,
      createdAt: new Date().toISOString(),
      version: manifest.version,
      files,
      scanCommand,
      assessment,
      immutable: true,
      deploymentPerformed: false,
      automaticScheduleInstalled: false,
    },
    null,
    2,
  )}\n`,
  { flag: "wx" },
);
const verified = await assessCandidate(output);
console.log(
  JSON.stringify(
    {
      candidate: output,
      candidateEligible: verified.candidateEligible,
      blockers: verified.blockers,
      vulnerabilityCounts: verified.vulnerabilities.counts,
      signatureVersion: verified.database.dailyVersion,
      signatureUpdatedAt: verified.database.updatedAt,
      publicationEligible: false,
    },
    null,
    2,
  ),
);
process.exitCode = verified.candidateEligible ? 0 : 2;
