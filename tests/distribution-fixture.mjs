import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { root } from "../scripts/source-scope.mjs";
import { packageBytes } from "./art-package-fixture.mjs";
import { cleanFact, jsonFact, queuedScan, runScanner } from "./scanner-fixture.mjs";
import { createVersion, review } from "./version-fixture.mjs";

let compilation;
async function compileCore() {
  const bundle = process.env.ASSETLIBRARY_BUNDLE;
  if (!bundle) throw new Error("ASSETLIBRARY_BUNDLE_REQUIRED");
  const output = await mkdtemp(
    path.join(path.dirname(path.dirname(bundle)), "assetlibrary-test-core-"),
  );
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/typescript/bin/tsc"),
      "--project",
      "tsconfig.json",
      "--noEmit",
      "false",
      "--module",
      "CommonJS",
      "--moduleResolution",
      "Node",
      "--outDir",
      output,
    ],
    { cwd: root, encoding: "utf8", timeout: 30000 },
  );
  await writeFile(
    path.join(output, "compile.log"),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
    "utf8",
  );
  if (result.error || result.status !== 0) throw new Error(`TEST_CORE_COMPILE_FAILED: ${output}`);
  await writeFile(path.join(output, "package.json"), '{"type":"commonjs"}\n', "utf8");
  const require = createRequire(path.join(output, "test.cjs"));
  return Object.assign(
    {},
    ...[
      "publications/mutations",
      "publications/records",
      "distribution/tickets",
      "distribution/content",
      "distribution/grants",
      "distribution/queries",
      "distribution/stream",
      "operations/events",
    ].map((module) => require(path.join(output, `${module}.js`))),
  );
}

export function coreModules() {
  compilation ??= compileCore();
  return compilation;
}

/** 明确是假设部署已准入的业务夹具：合成 clean 事实不是实际 AV/云验证。 */
export async function hypotheticalApproved(f, { member } = {}) {
  const bytes = packageBytes();
  const upload = await queuedScan(f, bytes);
  await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload)) });
  if (member) {
    assert.equal(
      (
        await f.request("PUT", `/v1/resources/${upload.resourceId}/members/${member}`, {
          revision: 1,
        })
      ).status,
      200,
    );
  }
  const created = await createVersion(f, upload);
  assert.equal(created.status, 201);
  const approved = await review(f, created.body);
  assert.equal(approved.status, 200);
  return { bytes, upload, version: approved.body };
}

export async function hypotheticalPublication(f, options) {
  const prepared = await hypotheticalApproved(f, options);
  const core = await coreModules();
  const response = await core.publishVersion(
    f.db,
    prepared.version.id,
    "user:alice",
    prepared.version.revision,
  );
  assert.equal(response.status, 201);
  return { ...prepared, publication: await response.json() };
}

export async function ticketFor(f, publication, actor = "user:alice") {
  const core = await coreModules();
  return (await core.issueTicket(f.db, publication.id, actor)).json();
}

export function contentRequest(publication, ticket, { method = "GET", headers, signal } = {}) {
  return new Request(`http://localhost/v1/publications/${publication.id}/content`, {
    method,
    headers: { "x-download-ticket": ticket.ticket, ...headers },
    ...(signal ? { signal } : {}),
  });
}

export async function publicationEvents(f, publication) {
  return (
    await f.db
      .prepare(
        "SELECT action, revision FROM publication_events WHERE publication_id = ? ORDER BY revision",
      )
      .bind(publication.id)
      .all()
  ).results;
}

export const denied = (promise, code = "NOT_FOUND") =>
  assert.rejects(promise, (error) => error.code === code);
