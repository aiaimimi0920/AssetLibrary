import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const workflow = (name) => readFileSync(new URL(`../.github/workflows/${name}.yml`, import.meta.url), "utf8");
const policy = workflow("security-policy");

function jobPermissions(source, name) {
  source = source.replace(/\r\n/g, "\n");
  const job = source.match(new RegExp(`^  ${name}:\\n[\\s\\S]*?(?=^  [\\w-]+:|$(?![\\s\\S]))`, "m"));
  assert.ok(job, `Missing job: ${name}`);
  const permissions = job[0].match(/^    permissions:\n((?:      [\w-]+: \w+\n)+)/m);
  assert.ok(permissions, `Missing explicit permissions for ${name}`);
  return Object.fromEntries([...permissions[1].matchAll(/      ([\w-]+): (\w+)/g)]
    .map((match) => [match[1], match[2]]));
}

test("the Gitleaks job can read PR metadata without any write scope", () => {
  assert.deepEqual(jobPermissions(policy, "secret-scan"), {
    contents: "read", "pull-requests": "read",
  });
  assert.match(policy, /GITLEAKS_ENABLE_COMMENTS: "false"/);
});

test("permission parsing accepts Windows checkout line endings", () => {
  assert.deepEqual(jobPermissions(policy.replace(/\r?\n/g, "\r\n"), "secret-scan"), {
    contents: "read", "pull-requests": "read",
  });
});

test("both reusable workflow callers pass the required read permission", () => {
  assert.deepEqual(jobPermissions(workflow("security"), "policy"), {
    actions: "read", contents: "read", "security-events": "write", "pull-requests": "read",
  });
  assert.deepEqual(jobPermissions(workflow("release"), "security"), {
    contents: "read", "security-events": "write", "pull-requests": "read",
  });
});

test("PR reads are confined to the scanner rather than inherited by other jobs", () => {
  const inherited = policy.split("\njobs:")[0];
  assert.doesNotMatch(inherited, /pull-requests:/);
  assert.equal((policy.match(/pull-requests: read/g) ?? []).length, 1);
  assert.doesNotMatch(policy, /pull-requests: write|continue-on-error: true/);
});

test("the repository CI policy invokes this permissions regression", () => {
  const checker = readFileSync(new URL("./Test-CiPolicy.ps1", import.meta.url), "utf8");
  assert.match(checker, /test-security-pr-permissions\.mjs/);
  assert.match(checker, /\$LASTEXITCODE -ne 0/);
});
