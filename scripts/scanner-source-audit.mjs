import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./scanner-release-policy.mjs";
import { assessCandidate, loadRelease, readJson } from "./scanner-release-proof.mjs";
import { assessSourceAudit, sourceProvenance, verifySourceBlob } from "./scanner-source-policy.mjs";
import { registryDocument, scanSourceLock, upstreamFile } from "./scanner-source-tools.mjs";
import { artifactRoot, root, sourceFiles } from "./source-scope.mjs";

const [input, executable, cacheInput, ...extra] = process.argv.slice(2);
assert(
  input && executable && cacheInput && !extra.length,
  "USAGE: scanner:source-audit <candidate> <trivy.exe> <cache>",
);
const candidate = path.resolve(input);
const trivy = path.resolve(executable);
const cache = path.resolve(cacheInput);
assert.equal(
  (await assessCandidate(candidate)).candidateEligible,
  true,
  "OS_CANDIDATE_NOT_ELIGIBLE",
);
const { runtime } = await loadRelease(candidate);
const dockerfile = await readFile(path.join(candidate, "scanner/Dockerfile"), "utf8");
const base = dockerfile.match(/^FROM (clamav\/clamav@sha256:[0-9a-f]{64})$/m)?.[1];
assert(base, "CANDIDATE_BASE_NOT_PINNED");
const sourceHashes = {};
for (const file of await sourceFiles())
  sourceHashes[file] = sha256(await readFile(path.join(root, file)));
const output = await mkdtemp(path.join(artifactRoot, "assetlibrary-source-audit-"));
await mkdir(path.join(output, "source"));
console.log(`Source audit evidence: ${output}`);
const wrapper = await registryDocument(base, "Provenance", `${output}/wrapper-provenance.json`);
const materials = wrapper.SLSA?.materials?.filter((item) =>
  item.uri?.startsWith("pkg:docker/clamav/clamav@"),
);
assert.equal(materials?.length, 1, "COMPILER_IMAGE_AMBIGUOUS");
assert(/^[0-9a-f]{64}$/.test(materials[0].digest?.sha256), "COMPILER_IMAGE_DIGEST_MISSING");
const compilerReference = `clamav/clamav@sha256:${materials[0].digest.sha256}`;
const compiler = await registryDocument(
  compilerReference,
  "Provenance",
  `${output}/compiler-provenance.json`,
);
const origin = sourceProvenance(wrapper, compiler);
const sbom = await registryDocument(base, "SBOM", `${output}/upstream-sbom.json`);
const requests = [];
requests.push(
  await upstreamFile(
    `https://raw.githubusercontent.com/Cisco-Talos/clamav/${origin.revision}/Cargo.lock`,
    `${output}/source/Cargo.lock`,
  ),
);
requests.push(
  await upstreamFile(
    `https://api.github.com/repos/Cisco-Talos/clamav/contents/Cargo.lock?ref=${origin.revision}`,
    `${output}/source-contents.json`,
  ),
);
const bytes = await readFile(`${output}/source/Cargo.lock`);
const source = verifySourceBlob(
  bytes,
  await readJson(`${output}/source-contents.json`),
  origin.revision,
);
const scanCommand = await scanSourceLock(trivy, cache, output);
assert.equal(
  sha256(await readFile(`${output}/source/Cargo.lock`)),
  source.sha256,
  "SOURCE_CHANGED_DURING_SCAN",
);
const assessment = assessSourceAudit({
  lock: bytes.toString("utf8"),
  sbom,
  compiler,
  report: await readJson(`${output}/vulnerabilities.json`),
  database: await readJson(`${output}/vulnerability-database.json`),
});
assert.deepEqual(Object.keys(sourceHashes), await sourceFiles(), "WORKSPACE_SOURCE_SET_CHANGED");
for (const [file, digest] of Object.entries(sourceHashes))
  assert.equal(sha256(await readFile(path.join(root, file))), digest, "WORKSPACE_SOURCE_CHANGED");
const files = {};
for (const file of (await readdir(output)).filter((name) => name !== "source"))
  files[file] = sha256(await readFile(path.join(output, file)));
files["source/Cargo.lock"] = source.sha256;
const receipt = {
  format: 1,
  at: new Date().toISOString(),
  candidate,
  imageId: runtime.image.id,
  candidateReleaseSha256: sha256(await readFile(path.join(candidate, "scanner/release.json"))),
  base,
  compilerReference,
  origin,
  source,
  requests,
  scanCommand,
  sourceHashes,
  files,
  assessment,
  registryAttachedProvenance: true,
  independentSignatureVerified: false,
  imageRebuilt: false,
  cloudMutation: false,
};
await writeFile(`${output}/source-audit.json`, `${JSON.stringify(receipt, null, 2)}\n`, {
  flag: "wx",
});
console.log(JSON.stringify({ output, source, assessment }, null, 2));
process.exitCode = assessment.supplyChainValidated ? 0 : 2;
