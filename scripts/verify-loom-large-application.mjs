import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "./build.mjs";
import { createTrialRuntime } from "./trial/runtime.mjs";
import { serveTrial } from "./trial/server.mjs";

const [loom, archive, label] = process.argv.slice(2);
if (
  process.argv.length !== 5 ||
  !path.isAbsolute(loom) ||
  !path.isAbsolute(archive) ||
  !label ||
  !process.env.LOOM_TEST_LIBARIA2
)
  throw new Error(
    "USAGE: verify-loom-large-application <absolute-loom> <absolute-package> <label>; LOOM_TEST_LIBARIA2 required",
  );
const runtime = await createTrialRuntime(await build());
let server;
const evidence = {
  passed: false,
  syntheticIdentity: true,
  cloudVerified: false,
  malwareScanning: "not_performed",
  desktopUiVerified: false,
  selfUpdateVerified: false,
};
try {
  server = await serveTrial(runtime, { onStop: () => {}, largeApplications: true });
  const tokens = new Map();
  for (const actor of ["10001", "10002", "10003"]) tokens.set(actor, await runtime.token(actor));
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
    kind: "application",
    title: "完整 Loom 大包联合验收",
  });
  async function publishArchive(archive, label) {
    const bytes = await readFile(archive);
    assert.ok(bytes.length > 8 * 1024 * 1024 && bytes.length <= 96_000_000);
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
      policy: "application-large-zip-format-v1",
    });
    await runtime.tick();
    const checked = await api("GET", `/v1/uploads/${upload.id}/inspection`);
    assert.equal(checked.state, "passed", JSON.stringify(checked));
    assert.equal(checked.result.scanStatus, "not_scanned");
    const version = await api("POST", `/v1/resources/${resource.id}/versions`, {
      label,
      uploadId: upload.id,
      resourceRevision: 1,
    });
    const reviewed = await api(
      "POST",
      `/v1/versions/${version.id}/review`,
      { revision: 1, decision: "approved", reason: "隔离本地完整程序包验证，不代表病毒扫描" },
      "10002",
    );
    const publication = await api("POST", `/v1/versions/${version.id}/publish`, {
      revision: reviewed.revision,
    });
    await api("PUT", `/v1/publications/${publication.id}/grants/trial:10003`, { revision: 0 });
    return {
      config: {
        mode: "local-trial-only",
        origin: server.origin,
        token: tokens.get("10003"),
        publicationId: publication.id,
        downloadRoot: runtime.state,
        sha256,
        kind: "application",
      },
      evidence: { publicationId: publication.id, size: bytes.length, sha256, label },
    };
  }
  let previous;
  if (process.env.LOOM_LARGE_PREVIOUS_PACKAGE) {
    assert.ok(path.isAbsolute(process.env.LOOM_LARGE_PREVIOUS_PACKAGE));
    assert.ok(
      process.env.LOOM_LARGE_PREVIOUS_LABEL && process.env.LOOM_LARGE_PREVIOUS_LABEL !== label,
    );
    previous = await publishArchive(
      process.env.LOOM_LARGE_PREVIOUS_PACKAGE,
      process.env.LOOM_LARGE_PREVIOUS_LABEL,
    );
  }
  const current = await publishArchive(archive, label);
  const configPath = path.join(runtime.state, "large-application-fixture.json");
  await writeFile(
    configPath,
    JSON.stringify({ ...current.config, ...(previous ? { previous: previous.config } : {}) }),
    "utf8",
  );
  const code = await new Promise((resolve, reject) => {
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
        "cloud_install_complete_loom_file_and_run_packaged_daemon",
        "--",
        "--ignored",
        "--nocapture",
        "--test-threads=1",
      ],
      {
        cwd: loom,
        windowsHide: true,
        env: {
          ...process.env,
          LOOM_LARGE_PACKAGE: archive,
          LOOM_LARGE_PACKAGE_LABEL: label,
          LOOM_LARGE_TRIAL_CONFIG: configPath,
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
    child.on("close", async (result) => {
      clearTimeout(timeout);
      try {
        await writeFile(path.join(runtime.state, "large-application-consumer.log"), log, "utf8");
        console.log(log);
        resolve(result === 0 && /1 passed/.test(log) ? 0 : 1);
      } catch (error) {
        reject(error);
      }
    });
  });
  assert.equal(code, 0, "LOOM_LARGE_CONSUMER_FAILED");
  Object.assign(evidence, {
    passed: true,
    ...current.evidence,
    previous: previous?.evidence,
    sameResourceUpdateVerified: Boolean(previous),
    downloadEngine: "libaria2",
  });
} finally {
  await writeFile(
    path.join(runtime.state, "large-application-evidence.json"),
    `${JSON.stringify(evidence, null, 2)}\n`,
    "utf8",
  );
  if (server) await server.close();
  await runtime.dispose();
  console.log(`Large application evidence: ${runtime.state}`);
}
