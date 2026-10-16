import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "./build.mjs";
import { createTrialRuntime } from "./trial/runtime.mjs";
import { serveTrial } from "./trial/server.mjs";

// 显式跨仓库验收，不进入默认测试或生产构建；只使用独占本地 trial。
const loom = process.argv[2];
const nativeFixture = process.argv[3];
if (
  !loom ||
  !path.isAbsolute(loom) ||
  ![3, 4].includes(process.argv.length) ||
  (nativeFixture && !path.isAbsolute(nativeFixture))
)
  throw new Error("ABSOLUTE_LOOM_REPOSITORY_REQUIRED");
await readFile(path.join(loom, "apps/daemon/src/asset_library/worker_integration.rs"));
const directory = await build();
const runtime = await createTrialRuntime(directory);
let server;
const tokens = new Map();
const results = [];
const sourceHashes = {};
for (const file of [
  "asset_library.rs",
  "asset_library/download.rs",
  "asset_library/worker_integration.rs",
  ...(nativeFixture
    ? [
        "asset_library/install.rs",
        "runtime/asset_library_install.rs",
        "tests/cloud_art_execution.rs",
        "tests/cloud_package_install.rs",
        "runtime/route_dispatch.rs",
      ]
    : []),
]) {
  sourceHashes[file] = createHash("sha256")
    .update(await readFile(path.join(loom, "apps/daemon/src", file)))
    .digest("hex");
}
try {
  server = await serveTrial(runtime, { onStop: () => {} });
  for (const number of ["10001", "10002", "10003"]) tokens.set(number, await runtime.token(number));
  async function api(method, route, body, number = "10001") {
    const response = await fetch(`${server.origin}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${tokens.get(number)}`,
        "idempotency-key": randomUUID(),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json();
    assert.ok(response.ok, `${method} ${route}: ${response.status} ${JSON.stringify(value)}`);
    return value;
  }
  for (const kind of nativeFixture ? ["art", "capability"] : ["art", "capability", "application"]) {
    const bytes = nativeFixture
      ? await readFile(
          path.join(
            nativeFixture,
            kind === "art"
              ? "arts-correct-publisher/custom-image-blend-script.zip"
              : "capability.zip",
          ),
        )
      : Buffer.from(
          await (
            await fetch(`${server.origin}/__trial/${kind === "art" ? "sample" : kind}.zip`)
          ).arrayBuffer(),
        );
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const resource = await api("POST", "/v1/resources", { kind, title: `Loom ${kind} 联合验收` });
    const upload = await api("POST", `/v1/resources/${resource.id}/uploads`, {
      size: bytes.length,
      sha256,
    });
    const put = await fetch(`${server.origin}/v1/uploads/${upload.id}/content`, {
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
      policy: `${nativeFixture ? "loom-" : ""}${kind}-zip-clamav-v1`,
    });
    await runtime.tick();
    assert.equal((await api("GET", `/v1/uploads/${upload.id}/inspection`)).state, "passed");
    const version = await api("POST", `/v1/resources/${resource.id}/versions`, {
      label: "v1",
      uploadId: upload.id,
      resourceRevision: 1,
    });
    const review = await api(
      "POST",
      `/v1/versions/${version.id}/review`,
      { revision: 1, decision: "approved", reason: "本地联合验收" },
      "10002",
    );
    const publication = await api("POST", `/v1/versions/${version.id}/publish`, {
      revision: review.revision,
    });
    const route = `/v1/publications/${publication.id}`;
    const grant = await api("PUT", `${route}/grants/trial:10003`, { revision: 0 });
    const library = await api("GET", "/v1/me/library", undefined, "10003");
    assert.ok(library.items.some((item) => item.id === publication.id));
    async function check(stage, expected) {
      const output = path.join(runtime.state, `${kind}-${stage}`);
      await mkdir(output);
      const fixture = path.join(output, "fixture.json");
      await writeFile(
        fixture,
        JSON.stringify({
          mode: "local-trial-only",
          origin: server.origin,
          token: tokens.get("10003"),
          publicationId: publication.id,
          downloadRoot: output,
          size: bytes.length,
          sha256,
          expected,
          kind,
        }),
        "utf8",
      );
      const log = await new Promise((resolve, reject) => {
        const child = spawn(
          "rtk",
          [
            "proxy",
            "cargo",
            "test",
            "--locked",
            "-p",
            "loom-daemon",
            nativeFixture
              ? kind === "art"
                ? "cloud_install_real_art_blends_image_with_packaged_framework"
                : "cloud_install_capability_requires_explicit_approval_then_runs_real_process"
              : "asset_library_worker_download_contract",
            "--",
            ...(!nativeFixture || kind === "art" ? ["--ignored"] : []),
            "--nocapture",
          ],
          {
            cwd: loom,
            env: {
              ...process.env,
              LOOM_ASSETLIBRARY_TEST_FIXTURE: fixture,
              ...(nativeFixture ? { LOOM_CLOUD_SIGNED_FIXTURE_ROOT: nativeFixture } : {}),
              ...(nativeFixture && kind === "capability"
                ? { LOOM_ASSETLIBRARY_NATIVE_CAPABILITY_FIXTURE: fixture }
                : {}),
            },
            windowsHide: true,
          },
        );
        let text = "";
        const timer = setTimeout(() => child.kill(), 300000);
        child.stdout.on("data", (chunk) => {
          text += chunk;
        });
        child.stderr.on("data", (chunk) => {
          text += chunk;
        });
        child.on("error", (error) => {
          clearTimeout(timer);
          reject(error);
        });
        child.on("close", (code) => {
          clearTimeout(timer);
          resolve({ code, text });
        });
      });
      await writeFile(path.join(output, "cargo.log"), log.text, "utf8");
      assert.ok(log.code === 0 && /1 passed/.test(log.text), `LOOM_CONTRACT_FAILED ${output}`);
      results.push({ kind, stage, expected, passed: true, size: bytes.length, sha256 });
      console.log(`LOOM_WORKER_CONTRACT_PASSED ${kind} ${stage}`);
    }
    await check("granted", "saved");
    await api("DELETE", `${route}/grants/trial:10003`, { revision: grant.revision });
    await check("revoked", "denied");
    await api("PUT", `${route}/grants/trial:10003`, { revision: grant.revision + 1 });
    await api("POST", `${route}/unlist`, { revision: publication.revision });
    await check("unlisted", "denied");
  }
} finally {
  await server?.close();
  await runtime.dispose();
  await writeFile(
    path.join(runtime.state, "loom-integration.json"),
    JSON.stringify(
      {
        mode: "local-trial-only",
        syntheticIdentity: true,
        syntheticAV: true,
        hypotheticalDeploymentAdmission: true,
        cloudVerified: false,
        nativeInstallMode: !!nativeFixture,
        nativeFlowPassed:
          !!nativeFixture && results.length === 6 && results.every((result) => result.passed),
        runtimeClosed: true,
        productionWorkerSha256: runtime.sourceHash,
        loomSourceHashes: sourceHashes,
        results,
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`LOOM_WORKER_EVIDENCE ${runtime.state}`);
}
