import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parsePublisherReleaseWorkspace } from "./publisher-workspace-parser";

let server: ChildProcess;
let origin: string;

beforeAll(async () => {
  server = spawn(process.execPath, [fileURLToPath(new URL("../../e2e/fixture-server.mjs", import.meta.url))], {
    env: { ...process.env, ASSETLIBRARY_BROWSER_FIXTURE_PORT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  origin = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Browser fixture did not start")), 5_000);
    let output = "";
    server.stdout?.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/browser fixture listening on (127\.0\.0\.1:\d+)/);
      if (match) { clearTimeout(timeout); resolve(`http://${match[1]}`); }
    });
    server.once("error", (error) => { clearTimeout(timeout); reject(error); });
    server.once("exit", () => { clearTimeout(timeout); reject(new Error("Browser fixture exited")); });
  });
});

afterAll(async () => {
  if (!server || server.exitCode !== null || server.signalCode !== null) return;
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(() => server.kill("SIGKILL"), 2_000);
    server.once("exit", () => { clearTimeout(timeout); resolve(); });
    server.kill("SIGTERM");
  });
});

async function call(path: string, body?: object): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer browser-fixture-access-token-that-stays-server-only",
      "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3_000),
  });
  expect(response.status).toBe(200);
  return response.json();
}

it("maps the upload digest object into an unverified workspace accepted by the production parser", async () => {
  const release = "/v1/me/releases/33333333-3333-4333-8333-333333333333";
  const workspace = async () => parsePublisherReleaseWorkspace(await call(`${release}/workspace`));
  expect((await workspace()).artifacts).toEqual([]);
  const digest = `sha256:${"a".repeat(64)}`;
  const request = { file_name: "browser-recovery.zip", media_type: "application/zip",
    part_size_bytes: 8_388_608, part_count: 2, size_bytes: 8_388_609,
    expected_digest: { algorithm: "sha256", value: digest } };
  await call(`${release}/upload-sessions`, request);
  expect((await workspace()).artifacts).toEqual([]);
  await call("/v1/me/upload-sessions/77777777-7777-4777-8777-777777777777/complete", { parts: [{}, {}] });
  const raw = await call(`${release}/workspace`);
  const [artifact] = parsePublisherReleaseWorkspace(raw).artifacts;
  expect(artifact).toMatchObject({ file_name: request.file_name, size_bytes: request.size_bytes,
    status: "uploaded", expected_digest: digest, verified_digest: null, scanner_version: null,
    rule_version: null, verified_at: null });
  const invalid = structuredClone(raw) as { artifacts: Array<{ expected_digest: unknown }> };
  invalid.artifacts[0].expected_digest = request.expected_digest;
  expect(() => parsePublisherReleaseWorkspace(invalid)).toThrow("Invalid Publisher artifact summary");
  await call("/fixture/reset-upload", {});
  expect((await workspace()).artifacts).toEqual([]);
});
