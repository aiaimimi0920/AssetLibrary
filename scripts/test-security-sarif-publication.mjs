import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const workflow = read(".github/workflows/security-policy.yml");
const pin = "2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2";

test("CodeQL publishes stable language categories and retains release evidence", () => {
  assert.match(workflow, /output: release\/evidence\/codeql\/\$\{\{ matrix.language \}\}\n\s+upload: always\n\s+category: \/language:\$\{\{ matrix.language \}\}/);
  assert.match(workflow, /name: Upload CodeQL SARIF evidence/);
  assert.ok(workflow.includes("hashFiles(format('release/evidence/codeql/{0}/**/*.sarif', matrix.language)) != ''"));
  assert.doesNotMatch(workflow, /upload: never|continue-on-error: true/);
});

test("OSV preserves raw exits, explicit locks, SARIF and strict release defaults", () => {
  for (const lock of ["Cargo.lock", "apps/web/pnpm-lock.yaml", "packages/api-client/pnpm-lock.yaml", "services/edge/pnpm-lock.yaml"]) {
    assert.ok(workflow.includes("--lockfile=/github/workspace/" + lock));
  }
  assert.ok(workflow.includes("scanner_status=$?"));
  assert.ok(workflow.includes("reporter_status=$?"));
  assert.ok(workflow.includes("python3 scripts/security_scan_summary.py osv"));
  assert.ok(workflow.includes("--all-packages --config=/github/workspace/osv-scanner.toml"));
  assert.ok(workflow.includes("steps.osv-report.outputs.report_valid == 'true'"));
  assert.ok(workflow.includes(`uses: github/codeql-action/upload-sarif@${pin}`));
  assert.match(workflow, /sarif_file: release\/evidence\/osv.sarif\n\s+category: osv-source\n\s+wait-for-processing: true/);
  assert.match(workflow, /development-advisory:[\s\S]*?default: false/);
  assert.doesNotMatch(read(".github/workflows/release.yml"), /development-advisory: true/);
  assert.ok(read(".github/workflows/security.yml").includes("development-advisory: ${{ !startsWith(github.ref, 'refs/tags/') }}"));
  assert.match(workflow, /name: Upload dependency and SBOM evidence\n\s+if: always\(\)/);
  assert.doesNotMatch(workflow, /\|\| true|continue-on-error/);
});

test("publication uses existing permission and scanner pins", () => {
  const policy = JSON.parse(read("security/dependency-security-policy.json"));
  assert.equal(policy.actions["github/codeql-action"], pin);
  assert.equal(workflow.split(policy.tool_images.osv_scanner).length - 1, 1);
  assert.ok(workflow.includes('docker run "${common[@]}" "$image"'));
  assert.doesNotMatch(workflow, /contents: write|packages: write|id-token:|pull_request_target/);
  assert.match(read("scripts/Test-CiPolicy.ps1"), /test-security-sarif-publication\.mjs/);
});


test("OSV invokes the binary explicitly and retains failure diagnostics", () => {
  assert.match(workflow, /common=\(.*--entrypoint \/osv-scanner/);
  assert.ok(workflow.includes('--user "$(id -u):$(id -g)"'));
  assert.ok(workflow.includes("release/evidence/osv-json.log"));
  assert.ok(workflow.includes("release/evidence/osv-sarif.log"));
});
