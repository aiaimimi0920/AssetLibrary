import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

test("Dependabot covers every first-party dependency lock ecosystem", () => {
  const source = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  const entries = source.replace(/\r\n/g, "\n").split(/\n  - package-ecosystem: /).slice(1);
  const scopes = entries.map((entry) => {
    const ecosystem = entry.split("\n", 1)[0];
    const directory = entry.match(/^    directory: (.+)$/m)?.[1];
    assert.ok(directory, "Each update entry needs an explicit repository directory");
    assert.match(entry, /interval: weekly/);
    assert.match(entry, /open-pull-requests-limit: (?:[1-9]|10)\b/);
    return `${ecosystem}:${directory}`;
  });
  assert.deepEqual(scopes.sort(), [
    "cargo:/", "github-actions:/", "npm:/apps/web", "npm:/packages/api-client", "npm:/services/edge",
  ]);
});
