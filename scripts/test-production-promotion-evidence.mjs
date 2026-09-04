import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = path.join(root, "test-results", "production-promotion-contract");
const evidenceDirectory = path.join(fixtureRoot, "evidence");
const manifestPath = path.join(evidenceDirectory, "promotion.json");
const verifier = path.join(root, "scripts", "verify-production-promotion.mjs");
const commit = "a".repeat(40);
const deploymentDigest = `sha256:${"d".repeat(64)}`;
const account = "b".repeat(64);
const cluster = "c".repeat(64);
const controllerImage = "quay.io/argoproj/argo-rollouts@sha256:15c0d41f2c69a382d4399bcb28ed4f03ee9f58b56cfc9e6cd55bcbf0f311c06d";
const components = ["api", "web", "scanner", "outbox", "indexer", "cleanup"];
const images = components.map((component, index) => ({
  component,
  image: `ghcr.io/neuro/assetlibrary/${component}`,
  digest: `sha256:${(index + 1).toString(16).repeat(64)}`,
}));

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function sha256(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function reference(directory, relativePath) {
  const filePath = path.join(directory, ...relativePath.split("/"));
  const stats = fs.statSync(filePath);
  return { path: relativePath, sha256: sha256(filePath), byte_length: stats.size, redacted: true };
}

function run(directory, report = "") {
  const args = [verifier, "--evidence", path.relative(root, path.join(directory, "promotion.json"))];
  if (report) args.push("--report", path.relative(root, report));
  return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
}

function expectSuccess(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim()}`);
}

function expectFailure(result, label) {
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded.`);
}

function writeFixture(directory) {
  fs.mkdirSync(directory, { recursive: true });
  writeJson(path.join(directory, "candidate/release-candidate.json"), {
    source_commit: commit, version: "1.2.3", production_release_eligible: false,
    app_updates_enabled: false, images,
  });
  const candidateHash = sha256(path.join(directory, "candidate/release-candidate.json"));
  fs.writeFileSync(path.join(directory, "candidate/SHA256SUMS"), `${candidateHash}  release-candidate.json\n`, "utf8");
  writeJson(path.join(directory, "p8/manifest.json"), {
    evidence_origin: "cloud", git_commit: commit,
    topology: { provider: "managed-kubernetes", account_ref_sha256: account, deployment_digest: deploymentDigest },
  });
  writeJson(path.join(directory, "p8/report.json"), {
    contract_valid: true, file_integrity_verified: true,
    production_authenticity_verified: false, p8_gate_eligible: false,
  });
  const rendered = [
    "apiVersion: argoproj.io/v1alpha1", "kind: Rollout", "setWeight: 5", "setWeight: 25", "setWeight: 100",
    `assetlibrary.neuro/required-rollouts-image: "${controllerImage}"`,
    "- name: ASSETLIBRARY_APP_UPDATES_ENABLED", '  value: "false"',
    ...images.map((image) => `image: ${image.image}@${image.digest}`), "",
  ].join("\n");
  fs.mkdirSync(path.join(directory, "provider"), { recursive: true });
  fs.writeFileSync(path.join(directory, "provider/rendered.yaml"), rendered, "utf8");
  writeJson(path.join(directory, "provider/controller.json"), {
    provider: "managed-kubernetes", account_ref_sha256: account, cluster_ref_sha256: cluster,
    workload_identity: "system:serviceaccount:argo-rollouts:controller", deployment_id: "deploy-123",
    version: "v1.9.1", image: controllerImage,
  });
  for (const [index, percent] of [5, 25, 100].entries()) {
    const start = `2026-09-04T0${index * 2}:00:00Z`;
    const end = `2026-09-04T0${index * 2 + 1}:00:00Z`;
    writeJson(path.join(directory, `canary/${percent}-metrics.json`), {
      traffic_percent: percent, deployment_digest: deploymentDigest, analysis_run_id: `analysis-${percent}`,
      controller_revision: "revision-7", window_start: start, window_end: end,
      observed_requests: 10000, maximum_5xx_ratio: 0.0001, api_p95_seconds: 0.2,
      web_p95_seconds: 0.3, error_budget_burn_rate: 0.1, firing_slo_alerts: 0,
    });
    writeJson(path.join(directory, `canary/${percent}-traffic.json`), {
      traffic_percent: percent, deployment_digest: deploymentDigest, provider: "managed-kubernetes",
      account_ref_sha256: account, cluster_ref_sha256: cluster, window_start: start, window_end: end,
      observed_requests: 10000,
    });
  }
  writeJson(path.join(directory, "records/database.json"), {
    backup_checkpoint: "backup-123", migration_set_sha256: "e".repeat(64), decision: "forward_only",
    automatic_destructive_rollback: false,
  });
  writeJson(path.join(directory, "records/rollback-policy.json"), { schema_version: "1.0", redacted: true });
  writeJson(path.join(directory, "records/rollback-evaluation.json"), {
    trigger_state: "no_slo_breach", evaluation: "no_rollback_required", deployment_digest: deploymentDigest,
  });
  for (const name of ["api", "edge", "event", "search", "audit"]) {
    writeJson(path.join(directory, `records/smoke-${name}.json`), { status: "passed", source_commit: commit, deployment_digest: deploymentDigest });
  }

  const windows = [5, 25, 100].map((percent, index) => ({
    traffic_percent: percent,
    window_start: `2026-09-04T0${index * 2}:00:00Z`,
    window_end: `2026-09-04T0${index * 2 + 1}:00:00Z`,
    deployment_digest: deploymentDigest,
    analysis_run_id: `analysis-${percent}`,
    controller_revision: "revision-7",
    observed_requests: 10000,
    maximum_5xx_ratio: 0.0001,
    api_p95_seconds: 0.2,
    web_p95_seconds: 0.3,
    error_budget_burn_rate: 0.1,
    firing_slo_alerts: 0,
    metrics: reference(directory, `canary/${percent}-metrics.json`),
    provider_traffic: reference(directory, `canary/${percent}-traffic.json`),
  }));
  const manifest = {
    schema_version: "1.0",
    record_state: "external_attestation_required",
    evidence_origin: "provider_exports_and_observations",
    environment: "production",
    record_id: "promotion-1.2.3-123",
    source_commit: commit,
    version: "1.2.3",
    candidate: {
      manifest: reference(directory, "candidate/release-candidate.json"),
      checksums: reference(directory, "candidate/SHA256SUMS"),
      source_commit: commit, version: "1.2.3", images,
    },
    p8: {
      manifest: reference(directory, "p8/manifest.json"), verification_report: reference(directory, "p8/report.json"),
      git_commit: commit, provider: "managed-kubernetes", account_ref_sha256: account,
      deployment_digest: deploymentDigest, contract_valid: true,
      provider_authenticity_verified: false, p8_gate_eligible: false,
    },
    provider_deployment: {
      provider: "managed-kubernetes", account_ref_sha256: account, cluster_ref_sha256: cluster,
      workload_identity: "system:serviceaccount:argo-rollouts:controller", deployment_id: "deploy-123", revision: "revision-7",
      deployment_digest: deploymentDigest, rendered_manifest: reference(directory, "provider/rendered.yaml"), images,
      controller: { version: "v1.9.1", image: controllerImage, runtime_identity: reference(directory, "provider/controller.json"), authenticated: false },
    },
    database_change: {
      backup_checkpoint: "backup-123", migration_set_sha256: "e".repeat(64), decision: "forward_only",
      automatic_destructive_rollback: false, evidence: reference(directory, "records/database.json"),
    },
    canary_windows: windows,
    rollback: {
      policy: reference(directory, "records/rollback-policy.json"),
      threshold_evaluation: reference(directory, "records/rollback-evaluation.json"),
      trigger_state: "no_slo_breach", evaluation: "no_rollback_required", action: null,
      app_rollback_only: true, database_rollback_automatic: false,
    },
    post_promotion: {
      checked_at: "2026-09-04T06:00:00Z", status: "passed",
      api: reference(directory, "records/smoke-api.json"), edge_download: reference(directory, "records/smoke-edge.json"),
      event: reference(directory, "records/smoke-event.json"), search: reference(directory, "records/smoke-search.json"),
      audit: reference(directory, "records/smoke-audit.json"),
    },
    review: { reviewer: "release-reviewer", reviewed_at: "2026-09-04T07:00:00Z", change_record: "change-123", decision: "pending_external_attestation" },
    provider_authenticity_verified: false,
    production_release_eligible: false,
    unmet_external_gates: ["p8_provider_authenticity", "deployment_provider_authenticity", "controller_runtime_authenticity", "promotion_approval_authenticity"],
  };
  writeJson(path.join(directory, "promotion.json"), manifest);
}

function clone(name) {
  const target = path.join(fixtureRoot, name);
  fs.cpSync(evidenceDirectory, target, { recursive: true });
  return target;
}

function mutateManifest(directory, mutate) {
  const filePath = path.join(directory, "promotion.json");
  const manifest = JSON.parse(fs.readFileSync(filePath, "utf8"));
  mutate(manifest);
  writeJson(filePath, manifest);
}

fs.rmSync(fixtureRoot, { recursive: true, force: true });
writeFixture(evidenceDirectory);
const reportPath = path.join(fixtureRoot, "verification-report.json");
expectSuccess(run(evidenceDirectory, reportPath), "valid promotion contract");
const report = JSON.parse(fs.readFileSync(reportPath, "utf8"));
if (report.production_release_eligible !== false || report.provider_authenticity_verified !== false) throw new Error("Local verifier granted production authenticity.");

const unsafe = clone("unsafe-claim");
mutateManifest(unsafe, (manifest) => { manifest.production_release_eligible = true; });
expectFailure(run(unsafe), "unsafe production claim");

const mismatchedImage = clone("mismatched-image");
mutateManifest(mismatchedImage, (manifest) => { manifest.provider_deployment.images[0].digest = `sha256:${"f".repeat(64)}`; });
expectFailure(run(mismatchedImage), "provider image mismatch");

const reordered = clone("reordered-windows");
mutateManifest(reordered, (manifest) => { [manifest.canary_windows[0], manifest.canary_windows[1]] = [manifest.canary_windows[1], manifest.canary_windows[0]]; });
expectFailure(run(reordered), "reordered canary windows");

const overlapping = clone("overlapping-windows");
mutateManifest(overlapping, (manifest) => { manifest.canary_windows[1].window_start = "2026-09-04T00:30:00Z"; });
expectFailure(run(overlapping), "overlapping canary windows");

const reused = clone("reused-evidence");
mutateManifest(reused, (manifest) => { manifest.post_promotion.audit = manifest.post_promotion.api; });
expectFailure(run(reused), "reused evidence path");

const tampered = clone("tampered-evidence");
fs.appendFileSync(path.join(tampered, "records/database.json"), " ", "utf8");
expectFailure(run(tampered), "tampered evidence file");

const localP8 = clone("local-p8");
const localP8Path = path.join(localP8, "p8/manifest.json");
const localP8Document = JSON.parse(fs.readFileSync(localP8Path, "utf8"));
localP8Document.evidence_origin = "local";
writeJson(localP8Path, localP8Document);
mutateManifest(localP8, (manifest) => { manifest.p8.manifest = reference(localP8, "p8/manifest.json"); });
expectFailure(run(localP8), "local P8 evidence");

const fakeRollback = clone("fake-rollback");
mutateManifest(fakeRollback, (manifest) => {
  manifest.rollback.trigger_state = "slo_breach";
  manifest.rollback.evaluation = "rollback_executed";
});
expectFailure(run(fakeRollback), "rollback without provider action evidence");

fs.rmSync(fixtureRoot, { recursive: true, force: true });
process.stdout.write("Production promotion evidence adversarial contract passed.\n");
