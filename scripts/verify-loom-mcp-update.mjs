import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applicationUpdateFixture } from "./application-update-fixture.mjs";
import { artZip } from "./art-package-zip.mjs";
import { build } from "./build.mjs";
import { createTrialRuntime } from "./trial/runtime.mjs";
import { serveTrial } from "./trial/server.mjs";

// 显式跨仓库本地联合验收：真实 HTTP 和宿主进程，账号是隔离 trial 主体。
const loom = process.argv[2];
const kind = process.argv[3] ?? "mcp";
if (
  !loom ||
  !path.isAbsolute(loom) ||
  process.argv.length > 4 ||
  !["mcp", "application", "capability"].includes(kind)
)
  throw new Error("ABSOLUTE_LOOM_REPOSITORY_REQUIRED");
const runtime = await createTrialRuntime(await build());
let server;
const evidence = {
  downloadEngine: process.env.LOOM_TEST_LIBARIA2 ? "libaria2" : "test-http",
  cloudVerified: false,
  syntheticIdentity: true,
  malwareScanning: "not_performed",
  passed: false,
  versions: [],
};
try {
  server = await serveTrial(runtime, { onStop: () => {} });
  const tokens = new Map();
  for (const id of ["10001", "10002", "10003"]) tokens.set(id, await runtime.token(id));
  async function api(method, route, body, actor = "10001") {
    const response = await fetch(`${server.origin}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens.get(actor)}`,
        "idempotency-key": randomUUID(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  const resource = await api("POST", "/v1/resources", {
    kind,
    title: `${kind} 版本调用联合验收`,
  });
  const script = await readFile(
    path.join(loom, "apps/daemon/src/tests/fixtures/cloud-mcp-version.ps1"),
  );
  const configs = {};
  for (const label of ["1.0.0", "1.1.0"]) {
    const manifest = {
      schemaVersion: 1,
      id: "cloud-version",
      name: "Cloud Version",
      version: label,
      publisher: { id: "test.cloud", name: "Test" },
      transport: "stdio",
      entry: { command: "runtime/server.ps1", args: [label] },
      tools: ["version"],
      credentials: [],
    };
    const bytes =
      kind === "capability"
        ? artZip(
            await Promise.all(
              [
                "capability.manifest.json",
                "ui.surface.json",
                "signature.json",
                "runtime/api-fixture.exe",
              ].map(async (name) => ({
                path: name,
                bytes: await readFile(
                  path.join(
                    process.env.LOOM_CLOUD_SIGNED_FIXTURE_ROOT,
                    `build-${label}`,
                    "api-fixture-package",
                    name,
                  ),
                ),
              })),
            ),
          )
        : kind === "application"
          ? await applicationUpdateFixture(loom, runtime.state, label)
          : artZip([
              { path: "mcp.server.json", bytes: Buffer.from(JSON.stringify(manifest)) },
              { path: "runtime/server.ps1", bytes: script },
            ]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const upload = await api("POST", `/v1/resources/${resource.id}/uploads`, {
      size: bytes.length,
      sha256,
    });
    const put = await fetch(`${server.origin}${upload.contentUrl}`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${tokens.get("10001")}`,
        "content-type": "application/octet-stream",
      },
      body: bytes,
    });
    assert.equal(put.status, 200, await put.text());
    await api("POST", `/v1/uploads/${upload.id}/complete`, {});
    await api("POST", `/v1/uploads/${upload.id}/inspection`, {
      policy: kind === "application" ? "application-zip-format-v1" : `loom-${kind}-zip-format-v1`,
    });
    await runtime.tick();
    const checked = await api("GET", `/v1/uploads/${upload.id}/inspection`);
    assert.equal(checked.state, "passed", JSON.stringify(checked));
    assert.equal(checked.result.scanStatus, "not_scanned");
    assert.equal(Object.hasOwn(checked.result, "scan"), false);
    const version = await api("POST", `/v1/resources/${resource.id}/versions`, {
      label,
      uploadId: upload.id,
      resourceRevision: 1,
    });
    const reviewed = await api(
      "POST",
      `/v1/versions/${version.id}/review`,
      { revision: 1, decision: "approved", reason: "本地业务验证，不代表安全扫描" },
      "10002",
    );
    const publication = await api("POST", `/v1/versions/${version.id}/publish`, {
      revision: reviewed.revision,
    });
    await api("PUT", `/v1/publications/${publication.id}/grants/trial:10003`, { revision: 0 });
    configs[label] = {
      mode: "local-trial-only",
      origin: server.origin,
      token: tokens.get("10003"),
      publicationId: publication.id,
      downloadRoot: runtime.state,
      sha256,
      kind,
    };
    evidence.versions.push({ label, publicationId: publication.id, sha256, size: bytes.length });
  }
  const configPath = path.join(runtime.state, `${kind}-update-fixture.json`);
  await writeFile(configPath, JSON.stringify(configs), "utf8");
  const result = await new Promise((resolve, reject) => {
    const child = spawn(
      "rtk",
      [
        "proxy",
        "cargo",
        "test",
        "--locked",
        "-p",
        "loom-daemon",
        "--lib",
        kind === "capability"
          ? "cloud_install_capability_updates_and_executes_selected_version"
          : kind === "application"
            ? "cloud_install_application_updates_and_runs_real_executable"
            : "cloud_install_mcp_updates_and_executes_selected_version",
        "--",
        ...(kind === "capability" ? ["--ignored"] : []),
        "--test-threads=1",
      ],
      {
        cwd: loom,
        windowsHide: true,
        env: {
          ...process.env,
          [`LOOM_ASSETLIBRARY_${kind.toUpperCase()}_UPDATE_FIXTURE`]: configPath,
        },
      },
    );
    let log = "";
    const timeout = setTimeout(() => child.kill(), 300000);
    child.stdout.on("data", (chunk) => {
      log += chunk;
    });
    child.stderr.on("data", (chunk) => {
      log += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve({ code, log });
    });
  });
  await writeFile(path.join(runtime.state, `${kind}-update-cargo.log`), result.log, "utf8");
  assert.ok(result.code === 0 && /1 passed/.test(result.log), result.log);
  if (kind === "capability") {
    evidence.executions = JSON.parse(
      await readFile(
        path.join(process.env.LOOM_CLOUD_SIGNED_FIXTURE_ROOT, "capability-execution-evidence.json"),
        "utf8",
      ),
    );
    assert.deepEqual(
      evidence.executions.map((entry) => entry.result.output.output.version),
      ["1.0.0", "1.1.0"],
    );
  }
  evidence.passed = true;
} finally {
  await server?.close();
  await runtime.dispose();
  await writeFile(
    path.join(runtime.state, `${kind}-update-evidence.json`),
    JSON.stringify(evidence, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      evidence: path.join(runtime.state, `${kind}-update-evidence.json`),
      passed: evidence.passed,
    }),
  );
}
