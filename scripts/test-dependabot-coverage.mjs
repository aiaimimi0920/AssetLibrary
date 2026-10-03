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

test("OpenTelemetry API, SDK, exporter and tracing bridge update together", () => {
  const source = readFileSync(new URL("../.github/dependabot.yml", import.meta.url), "utf8");
  const cargo = source.replace(/\r\n/g, "\n").split(/\n  - package-ecosystem: /)
    .slice(1).find((entry) => entry.startsWith("cargo\n"));
  assert.ok(cargo);
  assert.match(cargo, /    groups:\n      opentelemetry:\n        update-types: \[minor, patch\]\n        patterns:/);
  for (const name of ["opentelemetry", "opentelemetry-*", "opentelemetry_sdk", "tracing-opentelemetry"]) {
    assert.ok(cargo.includes(`          - "${name}"`), `${name} must update with its compatible family`);
  }
});
