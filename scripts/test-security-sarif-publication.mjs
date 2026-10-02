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

test("OSV preserves JSON and generates SARIF despite findings without masking failure", () => {
  assert.match(workflow, /scan source --recursive --format json --output-file \/evidence\/osv.json \/src/);
  assert.match(workflow, /name: Generate OSV SARIF for code scanning\n\s+if: \$\{\{ !cancelled\(\) && hashFiles\('release\/evidence\/osv.json'\) != '' \}\}/);
  assert.match(workflow, /scan source --recursive --format sarif --output-file \/evidence\/osv.sarif \./);
  assert.ok(workflow.includes('-v "$PWD:$PWD:ro" -w "$PWD"'));
  assert.match(workflow, /name: Upload OSV SARIF to code scanning\n\s+if: \$\{\{ !cancelled\(\) && hashFiles\('release\/evidence\/osv.sarif'\) != '' \}\}/);
  assert.ok(workflow.includes(`uses: github/codeql-action/upload-sarif@${pin}`));
  assert.match(workflow, /sarif_file: release\/evidence\/osv.sarif\n\s+category: osv-source\n\s+wait-for-processing: true/);
  assert.match(workflow, /name: Upload dependency and SBOM evidence\n\s+if: always\(\)/);
  assert.doesNotMatch(workflow, /\|\| true|continue-on-error/);
});

test("publication uses existing permission and scanner pins", () => {
  const policy = JSON.parse(read("security/dependency-security-policy.json"));
  assert.equal(policy.actions["github/codeql-action"], pin);
  assert.equal(workflow.split(policy.tool_images.osv_scanner).length - 1, 2);
  assert.doesNotMatch(workflow, /contents: write|packages: write|id-token:|pull_request_target/);
  assert.match(read("scripts/Test-CiPolicy.ps1"), /test-security-sarif-publication\.mjs/);
});
