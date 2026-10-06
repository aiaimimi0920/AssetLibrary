import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtureRoot = path.join(root, "test-results", "release-candidate-contract");
const fixtureDownloads = path.join(fixtureRoot, "downloads");
const tool = path.join(root, "scripts", "release-candidate-evidence.mjs");
const schemaValidator = path.join(root, "scripts", "validate-json-schema.mjs");
const schema = path.join(root, "schemas", "release-candidate-evidence.schema.json");
const version = "1.2.3-rc.1";
const commit = "a".repeat(40);
const registry = "ghcr.io/neuro/assetlibrary";
const components = ["api", "web", "scanner", "outbox", "indexer", "cleanup"];
const imageFiles = [
  "image.json",
  "image.spdx.json",
  "trivy-image.json",
  "cosign-verification.json",
  "provenance.sigstore.json",
  "sbom.sigstore.json",
];

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hash(filePath) {
  return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function run(parameters) {
  return spawnSync(process.execPath, [tool, ...parameters], { cwd: root, encoding: "utf8" });
}

function expectSuccess(result, label) {
  if (result.status !== 0) throw new Error(`${label} failed: ${(result.stderr || result.stdout).trim()}`);
}

function expectFailure(result, label) {
  if (result.status === 0) throw new Error(`${label} unexpectedly succeeded.`);
}

function prepareArgs(downloads, output) {
  return [
    "--phase", "prepare", "--downloads", path.relative(root, downloads), "--output", path.relative(root, output),
    "--version", version, "--commit", commit, "--registry-prefix", registry,
  ];
}

function finalizeArgs(output) {
  return [
    "--phase", "finalize", "--output", path.relative(root, output), "--version", version,
    "--commit", commit, "--repository", "neuro/assetlibrary", "--registry-prefix", registry,
    "--created-at", "2026-09-04T00:00:00Z", "--run-id", "12345", "--run-attempt", "1",
    "--identity", "https://github.com/neuro/assetlibrary/.github/workflows/release.yml@refs/tags/v1.2.3-rc.1",
  ];
}

function writeDownloads(directory) {
  const dependency = path.join(directory, `security-dependency-evidence-${commit}`);
  writeJson(path.join(dependency, "source.spdx.json"), { spdxVersion: "SPDX-2.3" });
  writeJson(path.join(dependency, "osv.json"), { results: [] });
  for (const name of ["web", "client", "edge"]) writeJson(path.join(dependency, `pnpm-audit-${name}.json`), { metadata: { vulnerabilities: {} } });
  writeJson(path.join(directory, `security-iac-evidence-${commit}`, "trivy-iac.json"), { SchemaVersion: 2, Results: [] });
  writeJson(path.join(directory, `quality-evidence-${commit}`, "ci.json"), {
    schema_version: "1.0",
    source_commit: commit,
    status: "passed",
    workflow_run_id: "12345",
    workflow_run_attempt: 1,
  });
  writeJson(path.join(directory, `image-runtime-evidence-${commit}`, "image-runtime.json"), {
    schema_version: "1.0",
    source_commit: commit,
    status: "passed",
    api_digest: `sha256:${"1".repeat(64)}`,
    web_digest: `sha256:${"2".repeat(64)}`,
    workflow_run_id: "12345",
    workflow_run_attempt: 1,
  });

  components.forEach((component, index) => {
    const imageDirectory = path.join(directory, `image-evidence-${component}-${commit}`);
    writeJson(path.join(imageDirectory, "image.json"), {
      schema_version: "1.0",
      component,
      image: `${registry}/${component}`,
      digest: `sha256:${(index + 1).toString(16).repeat(64)}`,
      version,
      git_commit: commit,
    });
    writeJson(path.join(imageDirectory, "image.spdx.json"), { spdxVersion: "SPDX-2.3" });
    writeJson(path.join(imageDirectory, "trivy-image.json"), { SchemaVersion: 2, Results: [] });
    writeJson(path.join(imageDirectory, "cosign-verification.json"), [{ verified: true }]);
    writeJson(path.join(imageDirectory, "provenance.sigstore.json"), { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" });
    writeJson(path.join(imageDirectory, "sbom.sigstore.json"), { mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json" });
    const sums = imageFiles.map((name) => `${hash(path.join(imageDirectory, name))}  ${name}`).join("\n");
    fs.writeFileSync(path.join(imageDirectory, "SHA256SUMS"), `${sums}\n`, "utf8");
  });
}

function writeRenderedManifest(output, omitComponent = "") {
  const lines = ["apiVersion: v1", "kind: List", "items:"];
  for (const component of components) {
    if (component === omitComponent) continue;
    const metadata = JSON.parse(fs.readFileSync(path.join(output, "images", component, "image.json"), "utf8"));
    lines.push(`  - image: ${metadata.image}@${metadata.digest}`);
  }
  lines.push("  - name: ASSETLIBRARY_APP_UPDATES_ENABLED", '    value: "false"', "");
  fs.writeFileSync(path.join(output, "deployment", "manifest.yaml"), lines.join("\n"), "utf8");
}

function writeProgressiveManifest(output, weights = [5, 25, 100]) {
  const controller = "quay.io/argoproj/argo-rollouts@sha256:15c0d41f2c69a382d4399bcb28ed4f03ee9f58b56cfc9e6cd55bcbf0f311c06d";
  const lines = [];
  for (const component of ["api", "web"]) {
    const metadata = JSON.parse(fs.readFileSync(path.join(output, "images", component, "image.json"), "utf8"));
    lines.push(
      "---", "apiVersion: argoproj.io/v1alpha1", "kind: Rollout", "metadata:", `  name: assetlibrary-${component}`,
      "  labels:", `    app.kubernetes.io/component: ${component}`, "  annotations:",
      '    assetlibrary.neuro/required-rollouts-version: "v1.9.1"', `    assetlibrary.neuro/required-rollouts-image: "${controller}"`,
      "spec:", "  progressDeadlineAbort: true", "  strategy:", "    canary:",
      `      stableService: assetlibrary-${component}`, `      canaryService: assetlibrary-${component}-canary`,
      "      trafficRouting:", "        nginx:", `          stableIngress: assetlibrary-${component}`, "      steps:",
    );
    for (const weight of weights) lines.push(`        - setWeight: ${weight}`, "        - analysis:", "            templates:", `              - templateName: assetlibrary-${component}-canary`);
    lines.push("  template:", "    spec:", "      containers:", `        - image: ${metadata.image}@${metadata.digest}`, "          env:", "            - name: ASSETLIBRARY_APP_UPDATES_ENABLED", '              value: "false"');
  }
  for (const component of ["api", "web"]) {
    for (const track of ["stable", "canary"]) {
      const suffix = track === "canary" ? "-canary" : "";
      lines.push(
        "---", "apiVersion: v1", "kind: Service", "metadata:", `  name: assetlibrary-${component}${suffix}`,
        "  labels:", `    assetlibrary.neuro/track: ${track}`, "spec:", "  selector:", `    app.kubernetes.io/component: ${component}`,
      );
    }
    lines.push(
      "---", "apiVersion: networking.k8s.io/v1", "kind: Ingress", "metadata:", `  name: assetlibrary-${component}`,
      "  annotations:", '    nginx.ingress.kubernetes.io/ssl-redirect: "true"', "spec:", "  tls:", `    - secretName: assetlibrary-${component}-tls`,
      "  rules:", "    - http:", "        paths:", "          - backend:", "              service:", `                name: assetlibrary-${component}`,
      "---", "apiVersion: argoproj.io/v1alpha1", "kind: AnalysisTemplate", "metadata:", `  name: assetlibrary-${component}-canary`, "spec:", "  metrics:",
    );
    const metrics = component === "api"
      ? ["api-canary-request-rate", "api-canary-5xx-ratio", "api-canary-p95", "global-slo-alerts"]
      : ["web-canary-request-rate", "web-canary-5xx-ratio", "web-canary-p95", "global-slo-alerts"];
    for (const metric of metrics) {
      lines.push(`    - name: ${metric}`, "      failureLimit: 0");
      if (metric.endsWith("request-rate")) {
        const selector = component === "api"
          ? 'service="assetlibrary-api",rollout_track="canary"'
          : 'ingress="assetlibrary-web-assetlibrary-web-canary"';
        lines.push("      provider:", "        prometheus:", `          query: sum(rate(requests_total{${selector}}[5m]))`);
      }
    }
  }
  lines.push(
    "---", "apiVersion: monitoring.coreos.com/v1", "kind: ServiceMonitor", "metadata:", "  name: assetlibrary",
    "spec:", "  endpoints:", "    - relabelings:", "        - sourceLabels: [__meta_kubernetes_service_label_assetlibrary_neuro_track]", "          targetLabel: rollout_track",
  );
  lines.push("---", "apiVersion: v1", "kind: List", "items:");
  for (const component of components.filter((name) => !["api", "web"].includes(name))) {
    const metadata = JSON.parse(fs.readFileSync(path.join(output, "images", component, "image.json"), "utf8"));
    lines.push(`  - image: ${metadata.image}@${metadata.digest}`);
  }
  fs.writeFileSync(path.join(output, "deployment", "progressive-manifest.yaml"), `${lines.join("\n")}\n`, "utf8");
}

fs.rmSync(fixtureRoot, { recursive: true, force: true });
writeDownloads(fixtureDownloads);

const candidate = path.join(fixtureRoot, "candidate");
expectSuccess(run(prepareArgs(fixtureDownloads, candidate)), "valid prepare");
writeRenderedManifest(candidate);
writeProgressiveManifest(candidate);
expectSuccess(run(finalizeArgs(candidate)), "valid finalize");
const schemaResult = spawnSync(process.execPath, [schemaValidator, "--schema", schema, "--document", path.join(candidate, "release-candidate.json")], { cwd: root, encoding: "utf8" });
expectSuccess(schemaResult, "candidate schema validation");
expectSuccess(run(["--phase", "verify", "--output", path.relative(root, candidate)]), "valid verify");

const tampered = path.join(fixtureRoot, "tampered");
fs.cpSync(candidate, tampered, { recursive: true });
fs.appendFileSync(path.join(tampered, "security", "osv.json"), " ", "utf8");
expectFailure(run(["--phase", "verify", "--output", path.relative(root, tampered)]), "tampered evidence");

const unsafeClaim = path.join(fixtureRoot, "unsafe-claim.json");
const claim = JSON.parse(fs.readFileSync(path.join(candidate, "release-candidate.json"), "utf8"));
claim.production_release_eligible = true;
writeJson(unsafeClaim, claim);
expectFailure(spawnSync(process.execPath, [schemaValidator, "--schema", schema, "--document", unsafeClaim], { cwd: root, encoding: "utf8" }), "unsafe production claim");

const checksumDownloads = path.join(fixtureRoot, "checksum-downloads");
fs.cpSync(fixtureDownloads, checksumDownloads, { recursive: true });
fs.appendFileSync(path.join(checksumDownloads, `image-evidence-api-${commit}`, "image.json"), " ", "utf8");
expectFailure(run(prepareArgs(checksumDownloads, path.join(fixtureRoot, "checksum-candidate"))), "image checksum mismatch");

const osvDownloads = path.join(fixtureRoot, "osv-downloads");
fs.cpSync(fixtureDownloads, osvDownloads, { recursive: true });
writeJson(path.join(osvDownloads, `security-dependency-evidence-${commit}`, "osv.json"), { results: [{ packages: [] }] });
expectFailure(run(prepareArgs(osvDownloads, path.join(fixtureRoot, "osv-candidate"))), "OSV finding");

const missingDigest = path.join(fixtureRoot, "missing-digest");
expectSuccess(run(prepareArgs(fixtureDownloads, missingDigest)), "missing-digest prepare");
writeRenderedManifest(missingDigest, "cleanup");
writeProgressiveManifest(missingDigest);
expectFailure(run(finalizeArgs(missingDigest)), "deployment without every digest");

const badWeights = path.join(fixtureRoot, "bad-weights");
expectSuccess(run(prepareArgs(fixtureDownloads, badWeights)), "bad-weights prepare");
writeRenderedManifest(badWeights);
writeProgressiveManifest(badWeights, [5, 25]);
expectFailure(run(finalizeArgs(badWeights)), "progressive deployment without the 100 percent gate");

fs.rmSync(fixtureRoot, { recursive: true, force: true });
process.stdout.write("Release candidate evidence adversarial contract passed.\n");
