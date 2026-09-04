import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const expectedComponents = ["api", "web", "scanner", "outbox", "indexer", "cleanup"];
const expectedGates = ["p8_provider_authenticity", "deployment_provider_authenticity", "controller_runtime_authenticity", "promotion_approval_authenticity"];
const maximumBytes = 512 * 1024 * 1024;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function argument(name, required = true) {
  const index = process.argv.indexOf(name);
  if (index < 0) {
    if (required) fail(`${name} is required.`);
    return "";
  }
  if (index + 1 >= process.argv.length) fail(`${name} requires a path.`);
  return process.argv[index + 1];
}

function inside(base, candidate) {
  const relative = path.relative(base, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function repositoryPath(raw, label) {
  const resolved = path.resolve(root, raw);
  assert(inside(root, resolved), `${label} must be inside the repository.`);
  return resolved;
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function boundedFile(filePath, label) {
  assert(fs.existsSync(filePath), `${label} is missing.`);
  const stats = fs.lstatSync(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} must be a regular file.`);
  assert(stats.size > 0 && stats.size <= maximumBytes, `${label} has an invalid size.`);
  return stats;
}

function readJson(filePath, label) {
  boundedFile(filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`${label} must be valid UTF-8 JSON.`);
  }
}

function walkFiles(directory, base = directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const stats = fs.lstatSync(absolute);
    assert(!stats.isSymbolicLink(), "Promotion evidence cannot contain symbolic links.");
    if (stats.isDirectory()) files.push(...walkFiles(absolute, base));
    else files.push(path.relative(base, absolute).split(path.sep).join("/"));
  }
  return files.sort();
}

function imageIdentity(images) {
  return images.map(({ component, image, digest }) => ({ component, image, digest }));
}

function validateImageSet(images, label) {
  assert(Array.isArray(images) && images.length === expectedComponents.length, `${label} must contain six images.`);
  assert(images.map((image) => image.component).join(",") === expectedComponents.join(","), `${label} component order is invalid.`);
  for (const image of images) assert(image.image.endsWith(`/${image.component}`) && /^sha256:[0-9a-f]{64}$/.test(image.digest), `${label} has an invalid component image.`);
}

const manifestPath = repositoryPath(argument("--evidence"), "Promotion manifest");
const evidenceDirectory = path.dirname(manifestPath);
assert(!fs.lstatSync(evidenceDirectory).isSymbolicLink(), "Promotion evidence directory cannot be a symbolic link.");
assert(inside(root, fs.realpathSync(evidenceDirectory)), "Promotion evidence directory resolves outside the repository.");
const schemaResult = spawnSync(process.execPath, [
  path.join(root, "scripts/validate-json-schema.mjs"),
  "--schema", path.join(root, "schemas/production-promotion-evidence.schema.json"),
  "--document", manifestPath,
], { cwd: root, encoding: "utf8" });
assert(schemaResult.status === 0, `Promotion JSON Schema validation failed: ${(schemaResult.stdout || schemaResult.stderr).trim().slice(0, 2048)}`);
const manifest = readJson(manifestPath, "Promotion manifest");

const resolvedEvidence = new Map();
function visit(value) {
  if (!value || typeof value !== "object") return;
  if (!Array.isArray(value) && Object.keys(value).sort().join(",") === "byte_length,path,redacted,sha256") {
    assert(!value.path.split("/").includes("..") && !value.path.includes("\\"), `Invalid evidence path: ${value.path}.`);
    assert(!resolvedEvidence.has(value.path), `Evidence path is reused: ${value.path}.`);
    const absolute = path.resolve(evidenceDirectory, ...value.path.split("/"));
    assert(inside(evidenceDirectory, absolute), `Evidence path escapes its directory: ${value.path}.`);
    const stats = boundedFile(absolute, value.path);
    assert(inside(fs.realpathSync(evidenceDirectory), fs.realpathSync(absolute)), `Evidence path resolves outside its directory: ${value.path}.`);
    assert(stats.size === value.byte_length && sha256(absolute) === value.sha256, `Evidence integrity mismatch: ${value.path}.`);
    resolvedEvidence.set(value.path, absolute);
    return;
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
}
visit(manifest);
const expectedFiles = [path.basename(manifestPath), ...resolvedEvidence.keys()].sort();
assert(JSON.stringify(walkFiles(evidenceDirectory)) === JSON.stringify(expectedFiles), "Promotion evidence directory contains missing or unreferenced files.");

assert(manifest.candidate.source_commit === manifest.source_commit && manifest.candidate.version === manifest.version, "Candidate identity does not match the promotion record.");
assert(manifest.p8.git_commit === manifest.source_commit, "P8 evidence is bound to another commit.");
assert(manifest.p8.provider === manifest.provider_deployment.provider && manifest.p8.account_ref_sha256 === manifest.provider_deployment.account_ref_sha256, "P8 provider/account does not match the deployment plane.");
assert(manifest.p8.deployment_digest === manifest.provider_deployment.deployment_digest, "P8 and provider deployment digests differ.");
validateImageSet(manifest.candidate.images, "Candidate images");
validateImageSet(manifest.provider_deployment.images, "Provider images");
assert(JSON.stringify(manifest.candidate.images) === JSON.stringify(manifest.provider_deployment.images), "Provider deployed images differ from the candidate.");

const candidateDocument = readJson(resolvedEvidence.get(manifest.candidate.manifest.path), "Referenced release candidate");
assert(candidateDocument.source_commit === manifest.source_commit && candidateDocument.version === manifest.version, "Referenced candidate identity differs from the promotion record.");
assert(candidateDocument.production_release_eligible === false && candidateDocument.app_updates_enabled === false, "Referenced candidate must remain non-production and App Update disabled.");
assert(JSON.stringify(imageIdentity(candidateDocument.images ?? [])) === JSON.stringify(manifest.candidate.images), "Referenced candidate images differ from the promotion record.");
const candidateSums = fs.readFileSync(resolvedEvidence.get(manifest.candidate.checksums.path), "utf8");
assert(candidateSums.split(/\r?\n/).includes(`${manifest.candidate.manifest.sha256}  release-candidate.json`), "Candidate checksum inventory does not bind release-candidate.json.");

const p8Document = readJson(resolvedEvidence.get(manifest.p8.manifest.path), "Referenced P8 manifest");
assert(p8Document.evidence_origin === "cloud" && p8Document.git_commit === manifest.source_commit, "Referenced P8 manifest is not same-commit cloud evidence.");
assert(p8Document.topology?.provider === manifest.p8.provider && p8Document.topology?.account_ref_sha256 === manifest.p8.account_ref_sha256 && p8Document.topology?.deployment_digest === manifest.p8.deployment_digest, "Referenced P8 topology differs from the promotion record.");
const p8Report = readJson(resolvedEvidence.get(manifest.p8.verification_report.path), "Referenced P8 verification report");
assert(p8Report.contract_valid === true && p8Report.file_integrity_verified === true && p8Report.production_authenticity_verified === false && p8Report.p8_gate_eligible === false, "P8 report must remain pending external authenticity.");

const databaseEvidence = readJson(resolvedEvidence.get(manifest.database_change.evidence.path), "Database change evidence");
for (const field of ["backup_checkpoint", "migration_set_sha256", "decision", "automatic_destructive_rollback"]) {
  assert(databaseEvidence[field] === manifest.database_change[field], `Database change evidence has a mismatched ${field}.`);
}

const deployedManifest = fs.readFileSync(resolvedEvidence.get(manifest.provider_deployment.rendered_manifest.path), "utf8");
for (const image of manifest.provider_deployment.images) assert(deployedManifest.includes(`${image.image}@${image.digest}`), `Provider manifest omits ${image.component} digest.`);
assert(deployedManifest.includes("kind: Rollout") && deployedManifest.includes("setWeight: 5") && deployedManifest.includes("setWeight: 25") && deployedManifest.includes("setWeight: 100"), "Provider manifest omits the required Rollout stages.");
assert(deployedManifest.includes('ASSETLIBRARY_APP_UPDATES_ENABLED') && deployedManifest.includes('value: "false"'), "Provider manifest must keep App Update disabled.");
assert(deployedManifest.includes(manifest.provider_deployment.controller.image), "Provider manifest does not bind the required controller image.");
const controllerIdentity = readJson(resolvedEvidence.get(manifest.provider_deployment.controller.runtime_identity.path), "Controller runtime identity");
for (const [field, expected] of Object.entries({ provider: manifest.provider_deployment.provider, account_ref_sha256: manifest.provider_deployment.account_ref_sha256, cluster_ref_sha256: manifest.provider_deployment.cluster_ref_sha256, workload_identity: manifest.provider_deployment.workload_identity, deployment_id: manifest.provider_deployment.deployment_id, version: manifest.provider_deployment.controller.version, image: manifest.provider_deployment.controller.image })) {
  assert(controllerIdentity[field] === expected, `Controller runtime identity has a mismatched ${field}.`);
}

let previousEnd = 0;
const analysisRuns = new Set();
for (const [index, window] of manifest.canary_windows.entries()) {
  assert(window.traffic_percent === [5, 25, 100][index], "Canary windows must be ordered 5/25/100.");
  const start = Date.parse(window.window_start);
  const end = Date.parse(window.window_end);
  assert(end - start >= 10 * 60 * 1000 && start >= previousEnd, "Canary windows must be at least ten minutes and non-overlapping.");
  previousEnd = end;
  assert(window.deployment_digest === manifest.provider_deployment.deployment_digest, "Canary window deployment digest mismatch.");
  assert(!analysisRuns.has(window.analysis_run_id), "Canary analysis run IDs must be unique.");
  analysisRuns.add(window.analysis_run_id);
  const metrics = readJson(resolvedEvidence.get(window.metrics.path), `${window.traffic_percent}% metrics`);
  const traffic = readJson(resolvedEvidence.get(window.provider_traffic.path), `${window.traffic_percent}% provider traffic`);
  for (const evidence of [metrics, traffic]) {
    assert(evidence.traffic_percent === window.traffic_percent && evidence.deployment_digest === window.deployment_digest, `${window.traffic_percent}% evidence is bound to another stage.`);
  }
  assert(metrics.analysis_run_id === window.analysis_run_id && metrics.controller_revision === window.controller_revision && metrics.window_start === window.window_start && metrics.window_end === window.window_end, `${window.traffic_percent}% metric window identity mismatch.`);
  for (const field of ["observed_requests", "maximum_5xx_ratio", "api_p95_seconds", "web_p95_seconds", "error_budget_burn_rate", "firing_slo_alerts"]) {
    assert(metrics[field] === window[field], `${window.traffic_percent}% metric summary has a mismatched ${field}.`);
  }
  assert(traffic.provider === manifest.provider_deployment.provider && traffic.account_ref_sha256 === manifest.provider_deployment.account_ref_sha256 && traffic.cluster_ref_sha256 === manifest.provider_deployment.cluster_ref_sha256 && traffic.window_start === window.window_start && traffic.window_end === window.window_end && traffic.observed_requests === window.observed_requests, `${window.traffic_percent}% provider traffic identity mismatch.`);
}

const checkedAt = Date.parse(manifest.post_promotion.checked_at);
assert(checkedAt >= previousEnd && Date.parse(manifest.review.reviewed_at) >= checkedAt, "Post-promotion checks and review must follow all canary windows.");
for (const channel of ["api", "edge_download", "event", "search", "audit"]) {
  const smoke = readJson(resolvedEvidence.get(manifest.post_promotion[channel].path), `${channel} smoke evidence`);
  assert(smoke.status === "passed" && smoke.source_commit === manifest.source_commit && smoke.deployment_digest === manifest.provider_deployment.deployment_digest, `${channel} smoke evidence is not a same-release pass.`);
}
const rollbackEvaluation = readJson(resolvedEvidence.get(manifest.rollback.threshold_evaluation.path), "Rollback threshold evaluation");
assert(rollbackEvaluation.trigger_state === manifest.rollback.trigger_state && rollbackEvaluation.evaluation === manifest.rollback.evaluation && rollbackEvaluation.deployment_digest === manifest.provider_deployment.deployment_digest, "Rollback threshold evaluation is not bound to this deployment decision.");
if (manifest.rollback.action) {
  assert(JSON.stringify(manifest.rollback.action.from_images) === JSON.stringify(manifest.provider_deployment.images), "Rollback source images differ from the deployed candidate.");
  assert(manifest.rollback.action.to_images.some((image, index) => image.digest !== manifest.provider_deployment.images[index].digest), "Rollback target must differ from the failed candidate.");
  const executedAt = Date.parse(manifest.rollback.action.executed_at);
  assert(executedAt >= previousEnd && executedAt <= checkedAt, "Rollback action time is outside the decision window.");
}
assert(JSON.stringify(manifest.unmet_external_gates) === JSON.stringify(expectedGates), "External authenticity gates are incomplete or reordered.");
assert(manifest.provider_authenticity_verified === false && manifest.production_release_eligible === false, "Repository verification cannot grant production eligibility.");

const reportPathRaw = argument("--report", false);
if (reportPathRaw) {
  const reportPath = repositoryPath(reportPathRaw, "Promotion report");
  assert(!inside(evidenceDirectory, reportPath) && reportPath !== manifestPath, "Promotion report must be outside the immutable evidence directory.");
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  const report = {
    schema_version: "1.0", verification_kind: "production_promotion_evidence_contract",
    evidence_manifest_sha256: sha256(manifestPath), verified_at: new Date().toISOString(),
    contract_valid: true, file_integrity_verified: true, provider_authenticity_verified: false,
    production_release_eligible: false,
    limitation: "Repository verification cannot authenticate provider, controller, reviewer, or promotion approval identities.",
  };
  const temporary = `${reportPath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, reportPath);
}

process.stdout.write("Production promotion evidence contract is valid; all production authenticity gates remain external.\n");
