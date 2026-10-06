import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { sha256 } from "./scanner-release-policy.mjs";
import { verifyTrivy } from "./scanner-release-tools.mjs";

const execute = promisify(execFile);

export async function registryDocument(reference, field, output) {
  assert(/^clamav\/clamav@sha256:[0-9a-f]{64}$/.test(reference), "REGISTRY_REFERENCE_INVALID");
  assert(["Provenance", "SBOM"].includes(field), "REGISTRY_FIELD_INVALID");
  const { stdout } = await execute(
    "rtk",
    [
      "proxy",
      "docker",
      "buildx",
      "imagetools",
      "inspect",
      reference,
      "--format",
      `{{json .${field}}}`,
    ],
    { timeout: 90000, maxBuffer: 8388608 },
  );
  const value = JSON.parse(stdout);
  assert(value && typeof value === "object", "REGISTRY_DOCUMENT_MISSING");
  await writeFile(output, stdout, { flag: "wx" });
  return value;
}

/** 只读公开上游；拒绝重定向、非预期主机及超限响应，不携带本机凭据。 */
export async function upstreamFile(url, output) {
  const parsed = new URL(url);
  assert(
    parsed.protocol === "https:" &&
      ["api.github.com", "raw.githubusercontent.com"].includes(parsed.hostname),
    "UPSTREAM_URL_INVALID",
  );
  assert(!parsed.username && !parsed.password, "UPSTREAM_CREDENTIALS_FORBIDDEN");
  const response = await fetch(url, {
    redirect: "error",
    signal: AbortSignal.timeout(45000),
    headers: { "User-Agent": "Neuro-AssetLibrary-source-audit" },
  });
  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error("UPSTREAM_HTTP_ERROR");
  }
  assert(response.body, "UPSTREAM_BODY_MISSING");
  const chunks = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      assert(size <= 2097152, "UPSTREAM_BODY_TOO_LARGE");
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = Buffer.concat(chunks);
  await writeFile(output, bytes, { flag: "wx" });
  return { url, bytes: size, sha256: sha256(bytes), fetchedAt: new Date().toISOString() };
}

export async function scanSourceLock(trivy, cache, directory) {
  await verifyTrivy(trivy);
  await writeFile(`${directory}/empty.yaml`, "{}\n", { flag: "wx" });
  await writeFile(`${directory}/empty.ignore`, "", { flag: "wx" });
  const args = [
    "proxy",
    trivy,
    "fs",
    "--cache-dir",
    cache,
    "--config",
    `${directory}/empty.yaml`,
    "--ignorefile",
    `${directory}/empty.ignore`,
    "--scanners",
    "vuln",
    "--severity",
    "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
    "--show-suppressed",
    "--list-all-pkgs",
    "--format",
    "json",
    "--output",
    `${directory}/vulnerabilities.json`,
    "--timeout",
    "5m",
    `${directory}/source`,
  ];
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.toUpperCase().startsWith("TRIVY_")),
  );
  let result;
  try {
    result = await execute("rtk", args, {
      cwd: directory,
      env,
      timeout: 360000,
      maxBuffer: 1048576,
    });
  } catch (error) {
    await writeFile(`${directory}/scan.log`, `${error.stdout ?? ""}${error.stderr ?? ""}`, {
      flag: "wx",
    });
    throw new Error("SOURCE_SCAN_EXECUTION_FAILED");
  }
  await writeFile(`${directory}/scan.log`, result.stdout + result.stderr, { flag: "wx" });
  await copyFile(`${cache}/db/metadata.json`, `${directory}/vulnerability-database.json`);
  return { args: args.slice(2), trivySha256: sha256(await readFile(trivy)), noIgnoreUnfixed: true };
}
