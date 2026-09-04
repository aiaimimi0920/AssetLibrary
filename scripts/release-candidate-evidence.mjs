import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { validateDeployment } from "./release-deployment-evidence.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const componentNames = ["api", "web", "scanner", "outbox", "indexer", "cleanup"];
const imageEvidenceNames = [
  "image.json",
  "image.spdx.json",
  "trivy-image.json",
  "cosign-verification.json",
  "provenance.sigstore.json",
  "sbom.sigstore.json",
  "SHA256SUMS",
];
const checksumTargets = imageEvidenceNames.filter((name) => name !== "SHA256SUMS");
const unmetProductionGates = [
  "p8_cloud_acceptance",
  "provider_release_authenticity",
  "canary_5_25_100",
  "automatic_rollback_and_slo_burn",
];
const maximumEvidenceBytes = 512 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function argumentsByName() {
  const values = new Map();
  for (let index = 2; index < process.argv.length; index += 2) {
    const name = process.argv[index];
    const value = process.argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) fail("Arguments must be --name value pairs.");
    values.set(name.slice(2), value);
  }
  return values;
}

const args = argumentsByName();
const required = (name) => {
  const value = args.get(name);
  if (!value) fail(`--${name} is required.`);
  return value;
};

function assert(condition, message) {
  if (!condition) fail(message);
}

function assertKeys(value, expected, label) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object.`);
  const actual = Object.keys(value).sort().join(",");
  assert(actual === [...expected].sort().join(","), `${label} has an unexpected property set.`);
}

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function repositoryPath(rawPath, label) {
  const resolved = path.resolve(repositoryRoot, rawPath);
  assert(inside(repositoryRoot, resolved), `${label} must be inside the repository.`);
  return resolved;
}

function assertNoLinks(target, label) {
  const stats = fs.lstatSync(target);
  assert(!stats.isSymbolicLink(), `${label} cannot be a symbolic link.`);
  if (!stats.isDirectory()) return;
  for (const entry of fs.readdirSync(target)) assertNoLinks(path.join(target, entry), label);
}

function boundedFile(filePath, label) {
  assert(fs.existsSync(filePath), `${label} is missing.`);
  const stats = fs.lstatSync(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} must be a regular file.`);
  assert(stats.size > 0 && stats.size <= maximumEvidenceBytes, `${label} has an invalid size.`);
  return stats;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readJson(filePath, label) {
  boundedFile(filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`${label} must be valid UTF-8 JSON.`);
  }
}

function exactEntries(directory, expected, label) {
  assert(fs.existsSync(directory) && fs.lstatSync(directory).isDirectory(), `${label} directory is missing.`);
  assertNoLinks(directory, label);
  const actual = fs.readdirSync(directory).sort().join(",");
  assert(actual === [...expected].sort().join(","), `${label} has an unexpected file set.`);
}

function validateSpdx(filePath, label) {
  const document = readJson(filePath, label);
  assert(/^SPDX-2\./.test(document.spdxVersion ?? ""), `${label} is not an SPDX JSON document.`);
}

function validateTrivy(filePath, label) {
  const report = readJson(filePath, label);
  assert(report.SchemaVersion === 2, `${label} has an unsupported Trivy schema.`);
  for (const result of report.Results ?? []) {
    for (const field of ["Vulnerabilities", "Misconfigurations", "Secrets"]) {
      assert(!Array.isArray(result[field]) || result[field].length === 0, `${label} contains ${field}.`);
    }
    assert((result.MisconfSummary?.Failures ?? 0) === 0, `${label} contains configuration failures.`);
  }
}

function validateChecksums(directory) {
  const lines = fs.readFileSync(path.join(directory, "SHA256SUMS"), "utf8").trim().split(/\r?\n/);
  const found = new Map();
  for (const line of lines) {
    const match = /^([0-9a-f]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
    assert(match && !found.has(match[2]), "Image SHA256SUMS is malformed or duplicated.");
    found.set(match[2], match[1]);
  }
  assert([...found.keys()].sort().join(",") === [...checksumTargets].sort().join(","), "Image SHA256SUMS has an unexpected file set.");
  for (const name of checksumTargets) assert(found.get(name) === sha256(path.join(directory, name)), `Image checksum mismatch: ${name}.`);
}

function validateImageDirectory(directory, component, version, commit, registryPrefix) {
  exactEntries(directory, imageEvidenceNames, `Image evidence for ${component}`);
  validateChecksums(directory);
  const metadata = readJson(path.join(directory, "image.json"), `${component} image metadata`);
  assertKeys(metadata, ["schema_version", "component", "image", "digest", "version", "git_commit"], `${component} image metadata`);
  assert(metadata.schema_version === "1.0" && metadata.component === component, `${component} image metadata identity is invalid.`);
  assert(metadata.version === version && metadata.git_commit === commit, `${component} image metadata is bound to another source.`);
  assert(metadata.image === `${registryPrefix}/${component}`, `${component} image registry path is invalid.`);
  assert(/^sha256:[0-9a-f]{64}$/.test(metadata.digest), `${component} image digest is invalid.`);
  validateSpdx(path.join(directory, "image.spdx.json"), `${component} image SBOM`);
  validateTrivy(path.join(directory, "trivy-image.json"), `${component} image scan`);
  const signatures = readJson(path.join(directory, "cosign-verification.json"), `${component} signature verification`);
  assert(Array.isArray(signatures) && signatures.length > 0, `${component} signature verification is empty.`);
  readJson(path.join(directory, "provenance.sigstore.json"), `${component} provenance bundle`);
  readJson(path.join(directory, "sbom.sigstore.json"), `${component} SBOM attestation bundle`);
  return metadata;
}

function copyExactFiles(source, destination, names) {
  fs.mkdirSync(destination, { recursive: true });
  for (const name of names) fs.copyFileSync(path.join(source, name), path.join(destination, name));
}

function validateSecurity(directory, commit) {
  const dependency = path.join(directory, `security-dependency-evidence-${commit}`);
  const iac = path.join(directory, `security-iac-evidence-${commit}`);
  const quality = path.join(directory, `quality-evidence-${commit}`);
  const imageRuntime = path.join(directory, `image-runtime-evidence-${commit}`);
  const dependencyFiles = ["source.spdx.json", "osv.json", "pnpm-audit-web.json", "pnpm-audit-client.json", "pnpm-audit-edge.json"];
  exactEntries(dependency, dependencyFiles, "Dependency evidence");
  exactEntries(iac, ["trivy-iac.json"], "IaC evidence");
  exactEntries(quality, ["ci.json"], "Quality evidence");
  exactEntries(imageRuntime, ["image-runtime.json"], "Image runtime evidence");
  validateSpdx(path.join(dependency, "source.spdx.json"), "Source SBOM");
  const osv = readJson(path.join(dependency, "osv.json"), "OSV report");
  assert(Array.isArray(osv.results) && osv.results.length === 0, "OSV report contains findings or has an unsupported shape.");
  for (const name of dependencyFiles.filter((name) => name.startsWith("pnpm-audit-"))) readJson(path.join(dependency, name), name);
  validateTrivy(path.join(iac, "trivy-iac.json"), "IaC scan");
  const ci = readJson(path.join(quality, "ci.json"), "Quality evidence");
  assertKeys(ci, ["schema_version", "source_commit", "status", "workflow_run_id", "workflow_run_attempt"], "Quality evidence");
  assert(ci.schema_version === "1.0" && ci.source_commit === commit && ci.status === "passed", "Quality evidence is not bound to this passing commit.");
  const runtime = readJson(path.join(imageRuntime, "image-runtime.json"), "Image runtime evidence");
  assertKeys(runtime, ["schema_version", "source_commit", "status", "api_digest", "web_digest", "workflow_run_id", "workflow_run_attempt"], "Image runtime evidence");
  assert(runtime.schema_version === "1.0" && runtime.source_commit === commit && runtime.status === "passed", "Image runtime evidence is not bound to this passing commit.");
  assert(/^sha256:[0-9a-f]{64}$/.test(runtime.api_digest) && /^sha256:[0-9a-f]{64}$/.test(runtime.web_digest), "Image runtime evidence has an invalid digest.");
  return { dependency, iac, quality, imageRuntime, dependencyFiles };
}

function prepare(downloads, output, version, commit, registryPrefix) {
  assert(!fs.existsSync(output), "Candidate output directory must not already exist.");
  assertNoLinks(downloads, "Downloaded evidence");
  const security = validateSecurity(downloads, commit);
  fs.mkdirSync(output, { recursive: true });
  const images = [];
  for (const component of componentNames) {
    const source = path.join(downloads, `image-evidence-${component}-${commit}`);
    const metadata = validateImageDirectory(source, component, version, commit, registryPrefix);
    copyExactFiles(source, path.join(output, "images", component), imageEvidenceNames);
    images.push(metadata);
  }
  copyExactFiles(security.dependency, path.join(output, "security"), security.dependencyFiles);
  copyExactFiles(security.iac, path.join(output, "security"), ["trivy-iac.json"]);
  copyExactFiles(security.quality, path.join(output, "tests"), ["ci.json"]);
  copyExactFiles(security.imageRuntime, path.join(output, "tests"), ["image-runtime.json"]);

  const migrationSource = path.join(repositoryRoot, "migrations");
  const migrations = fs.readdirSync(migrationSource).filter((name) => /^[0-9]{4}_[A-Za-z0-9_-]+\.sql$/.test(name)).sort();
  assert(migrations.length > 0, "No ordered SQL migrations were found.");
  migrations.forEach((name, index) => assert(Number(name.slice(0, 4)) === index + 1, "Migration numbering must be contiguous from 0001."));
  copyExactFiles(migrationSource, path.join(output, "migrations"), migrations);

  const matrix = readJson(path.join(repositoryRoot, "deploy/images/build-matrix.json"), "Build matrix");
  const clamav = matrix.base_images?.clamav_runtime;
  assert(/^docker\.io\/clamav\/clamav@sha256:[0-9a-f]{64}$/.test(clamav ?? ""), "ClamAV runtime must be digest pinned.");
  const byComponent = new Map(images.map((image) => [image.component, `${image.image}@${image.digest}`]));
  const values = [
    `api:\n  image: "${byComponent.get("api")}"`,
    `web:\n  image: "${byComponent.get("web")}"`,
    `scanner:\n  image: "${byComponent.get("scanner")}"\n  clamav:\n    image: "${clamav}"`,
    `outbox:\n  image: "${byComponent.get("outbox")}"`,
    `indexer:\n  image: "${byComponent.get("indexer")}"`,
    `cleanup:\n  image: "${byComponent.get("cleanup")}"`,
    "config:\n  appUpdatesEnabled: false",
    "",
  ].join("\n");
  fs.mkdirSync(path.join(output, "deployment"), { recursive: true });
  fs.writeFileSync(path.join(output, "deployment/values.yaml"), values, "utf8");
}

function evidenceReference(output, relativePath) {
  assert(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(relativePath) && !relativePath.split("/").includes(".."), `Invalid evidence path: ${relativePath}.`);
  const filePath = path.join(output, ...relativePath.split("/"));
  const stats = boundedFile(filePath, relativePath);
  return { path: relativePath, sha256: sha256(filePath), byte_length: stats.size };
}

function imageRecord(output, component, version, commit, registryPrefix) {
  const directory = path.join(output, "images", component);
  const metadata = validateImageDirectory(directory, component, version, commit, registryPrefix);
  return {
    component,
    image: metadata.image,
    digest: metadata.digest,
    evidence: {
      metadata: evidenceReference(output, `images/${component}/image.json`),
      sbom: evidenceReference(output, `images/${component}/image.spdx.json`),
      vulnerability_scan: evidenceReference(output, `images/${component}/trivy-image.json`),
      signature_verification: evidenceReference(output, `images/${component}/cosign-verification.json`),
      provenance: evidenceReference(output, `images/${component}/provenance.sigstore.json`),
      sbom_attestation: evidenceReference(output, `images/${component}/sbom.sigstore.json`),
      checksums: evidenceReference(output, `images/${component}/SHA256SUMS`),
    },
  };
}

function allFiles(directory, base = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    assert(!entry.isSymbolicLink(), "Candidate evidence cannot contain symbolic links.");
    if (entry.isDirectory()) files.push(...allFiles(absolute, base));
    else if (entry.name !== "SHA256SUMS" || path.dirname(absolute) !== base) files.push(path.relative(base, absolute).split(path.sep).join("/"));
  }
  return files.sort();
}

function finalize(output, metadata) {
  const images = componentNames.map((component) => imageRecord(output, component, metadata.version, metadata.commit, metadata.registryPrefix));
  validateDeployment({ output, images, assert, boundedFile });

  const migrationNames = fs.readdirSync(path.join(output, "migrations")).sort();
  migrationNames.forEach((name, index) => assert(Number(name.slice(0, 4)) === index + 1, "Candidate migrations are not contiguous."));
  const policy = readJson(path.join(repositoryRoot, "security/dependency-security-policy.json"), "Security policy");
  const helmImage = policy.tool_images?.helm;
  assert(/@sha256:[0-9a-f]{64}$/.test(helmImage ?? ""), "Helm tool image must be digest pinned.");
  const manifest = {
    schema_version: "1.0",
    candidate_state: "signed_images_security_scanned",
    version: metadata.version,
    source_commit: metadata.commit,
    repository: metadata.repository,
    registry_prefix: metadata.registryPrefix,
    created_at: metadata.createdAt,
    workflow: { run_id: metadata.runId, run_attempt: metadata.runAttempt, identity: metadata.identity },
    toolchain: {
      security_policy_sha256: sha256(path.join(repositoryRoot, "security/dependency-security-policy.json")),
      build_matrix_sha256: sha256(path.join(repositoryRoot, "deploy/images/build-matrix.json")),
      helm_image: helmImage,
    },
    security: {
      source_sbom: evidenceReference(output, "security/source.spdx.json"),
      osv: evidenceReference(output, "security/osv.json"),
      pnpm_audits: {
        web: evidenceReference(output, "security/pnpm-audit-web.json"),
        api_client: evidenceReference(output, "security/pnpm-audit-client.json"),
        edge: evidenceReference(output, "security/pnpm-audit-edge.json"),
      },
      iac_scan: evidenceReference(output, "security/trivy-iac.json"),
    },
    tests: {
      ci: evidenceReference(output, "tests/ci.json"),
      image_runtime: evidenceReference(output, "tests/image-runtime.json"),
    },
    images,
    migrations: { ordered: true, files: migrationNames.map((name) => ({ name, evidence: evidenceReference(output, `migrations/${name}`) })) },
    deployment: {
      helm_values: evidenceReference(output, "deployment/values.yaml"),
      rendered_manifest: evidenceReference(output, "deployment/manifest.yaml"),
      progressive_manifest: evidenceReference(output, "deployment/progressive-manifest.yaml"),
      images_digest_bound: true,
      app_updates_enabled: false,
    },
    app_updates_enabled: false,
    production_release_eligible: false,
    unmet_production_gates: unmetProductionGates,
  };
  fs.writeFileSync(path.join(output, "release-candidate.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  const sums = allFiles(output).map((name) => `${sha256(path.join(output, ...name.split("/")))}  ${name}`).join("\n");
  fs.writeFileSync(path.join(output, "SHA256SUMS"), `${sums}\n`, "utf8");
}

function verify(output) {
  const schemaValidation = spawnSync(process.execPath, [
    path.join(repositoryRoot, "scripts/validate-json-schema.mjs"),
    "--schema", path.join(repositoryRoot, "schemas/release-candidate-evidence.schema.json"),
    "--document", path.join(output, "release-candidate.json"),
  ], { cwd: repositoryRoot, encoding: "utf8" });
  const schemaDetail = (schemaValidation.stdout || schemaValidation.stderr || "schema validation failed").trim().slice(0, 2048);
  assert(schemaValidation.status === 0, `Candidate JSON Schema validation failed: ${schemaDetail}`);
  assertNoLinks(output, "Candidate evidence");
  exactEntries(output, ["SHA256SUMS", "deployment", "images", "migrations", "release-candidate.json", "security", "tests"], "Candidate evidence");
  exactEntries(path.join(output, "images"), componentNames, "Candidate images");
  exactEntries(path.join(output, "security"), ["source.spdx.json", "osv.json", "pnpm-audit-web.json", "pnpm-audit-client.json", "pnpm-audit-edge.json", "trivy-iac.json"], "Candidate security evidence");
  exactEntries(path.join(output, "tests"), ["ci.json", "image-runtime.json"], "Candidate test evidence");
  exactEntries(path.join(output, "deployment"), ["manifest.yaml", "progressive-manifest.yaml", "values.yaml"], "Candidate deployment evidence");
  const manifest = readJson(path.join(output, "release-candidate.json"), "Release candidate manifest");
  assert(manifest.production_release_eligible === false && manifest.app_updates_enabled === false, "Candidate cannot claim production or App Update eligibility.");
  assert(JSON.stringify(manifest.unmet_production_gates) === JSON.stringify(unmetProductionGates), "Candidate production blockers are incomplete.");
  const expectedIdentity = `https://github.com/${manifest.repository}/.github/workflows/release.yml@refs/`;
  assert(manifest.workflow?.identity?.startsWith(expectedIdentity), "Candidate workflow identity does not match its repository.");
  assert(manifest.registry_prefix === `ghcr.io/${manifest.repository.toLowerCase()}`, "Candidate registry prefix does not match its repository.");
  const seen = new Set();
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (!Array.isArray(value) && Object.keys(value).sort().join(",") === "byte_length,path,sha256") {
      assert(!seen.has(value.path), `Evidence path is reused: ${value.path}.`);
      seen.add(value.path);
      const actual = evidenceReference(output, value.path);
      assert(actual.sha256 === value.sha256 && actual.byte_length === value.byte_length, `Evidence reference mismatch: ${value.path}.`);
      return;
    }
    for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
  };
  visit(manifest);
  const checksumPath = path.join(output, "SHA256SUMS");
  const expected = allFiles(output).map((name) => `${sha256(path.join(output, ...name.split("/")))}  ${name}`).join("\n") + "\n";
  assert(fs.readFileSync(checksumPath, "utf8") === expected, "Candidate top-level checksums do not match its files.");
  const images = componentNames.map((component) => imageRecord(output, component, manifest.version, manifest.source_commit, manifest.registry_prefix));
  assert(JSON.stringify(manifest.images) === JSON.stringify(images), "Candidate image manifest does not match its evidence directories.");
  validateDeployment({ output, images, assert, boundedFile });
  const migrationNames = fs.readdirSync(path.join(output, "migrations")).sort();
  migrationNames.forEach((name, index) => assert(Number(name.slice(0, 4)) === index + 1, "Candidate migrations are not contiguous."));
  const migrations = { ordered: true, files: migrationNames.map((name) => ({ name, evidence: evidenceReference(output, `migrations/${name}`) })) };
  assert(JSON.stringify(manifest.migrations) === JSON.stringify(migrations), "Candidate migration manifest does not match its files.");
  const expectedSecurity = {
    source_sbom: evidenceReference(output, "security/source.spdx.json"),
    osv: evidenceReference(output, "security/osv.json"),
    pnpm_audits: {
      web: evidenceReference(output, "security/pnpm-audit-web.json"),
      api_client: evidenceReference(output, "security/pnpm-audit-client.json"),
      edge: evidenceReference(output, "security/pnpm-audit-edge.json"),
    },
    iac_scan: evidenceReference(output, "security/trivy-iac.json"),
  };
  assert(JSON.stringify(manifest.security) === JSON.stringify(expectedSecurity), "Candidate security manifest does not match its files.");
  const expectedTests = {
    ci: evidenceReference(output, "tests/ci.json"),
    image_runtime: evidenceReference(output, "tests/image-runtime.json"),
  };
  assert(JSON.stringify(manifest.tests) === JSON.stringify(expectedTests), "Candidate test manifest does not match its files.");
  const expectedDeployment = {
    helm_values: evidenceReference(output, "deployment/values.yaml"),
    rendered_manifest: evidenceReference(output, "deployment/manifest.yaml"),
    progressive_manifest: evidenceReference(output, "deployment/progressive-manifest.yaml"),
    images_digest_bound: true,
    app_updates_enabled: false,
  };
  assert(JSON.stringify(manifest.deployment) === JSON.stringify(expectedDeployment), "Candidate deployment manifest does not match its files.");
  const policyPath = path.join(repositoryRoot, "security/dependency-security-policy.json");
  const matrixPath = path.join(repositoryRoot, "deploy/images/build-matrix.json");
  const policy = readJson(policyPath, "Security policy");
  const expectedToolchain = { security_policy_sha256: sha256(policyPath), build_matrix_sha256: sha256(matrixPath), helm_image: policy.tool_images?.helm };
  assert(JSON.stringify(manifest.toolchain) === JSON.stringify(expectedToolchain), "Candidate toolchain does not match repository policy.");
  validateSecurityCandidate(output, manifest.source_commit, images);
}

function validateSecurityCandidate(output, commit, images) {
  validateSpdx(path.join(output, "security/source.spdx.json"), "Source SBOM");
  const osv = readJson(path.join(output, "security/osv.json"), "OSV report");
  assert(Array.isArray(osv.results) && osv.results.length === 0, "Candidate OSV report contains findings.");
  for (const name of ["web", "client", "edge"]) readJson(path.join(output, `security/pnpm-audit-${name}.json`), `${name} pnpm audit`);
  validateTrivy(path.join(output, "security/trivy-iac.json"), "IaC scan");
  const ci = readJson(path.join(output, "tests/ci.json"), "Quality evidence");
  assert(ci.source_commit === commit && ci.status === "passed", "Candidate quality evidence is not a same-commit pass.");
  const runtime = readJson(path.join(output, "tests/image-runtime.json"), "Image runtime evidence");
  const byComponent = new Map(images.map((image) => [image.component, image.digest]));
  assert(runtime.source_commit === commit && runtime.status === "passed", "Candidate image runtime evidence is not a same-commit pass.");
  assert(runtime.api_digest === byComponent.get("api") && runtime.web_digest === byComponent.get("web"), "Image runtime evidence is bound to different digests.");
}

const phase = required("phase");
const output = repositoryPath(required("output"), "Candidate output");
if (phase === "prepare") {
  const downloads = repositoryPath(required("downloads"), "Downloaded evidence");
  const version = required("version");
  const commit = required("commit");
  const registryPrefix = required("registry-prefix");
  assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(version), "Version must be SemVer.");
  assert(/^[0-9a-f]{40}$/.test(commit), "Commit must be a full lowercase SHA.");
  assert(/^ghcr\.io\/[a-z0-9._/-]+$/.test(registryPrefix), "Registry prefix is invalid.");
  prepare(downloads, output, version, commit, registryPrefix);
} else if (phase === "finalize") {
  finalize(output, {
    version: required("version"), commit: required("commit"), repository: required("repository"),
    registryPrefix: required("registry-prefix"), createdAt: required("created-at"), runId: required("run-id"),
    runAttempt: Number(required("run-attempt")), identity: required("identity"),
  });
} else if (phase === "verify") {
  verify(output);
} else fail("--phase must be prepare, finalize, or verify.");

process.stdout.write(`Release candidate evidence ${phase} passed.\n`);
