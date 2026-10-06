import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { parsePublisherReleaseWorkspace } from "./publisher-workspace-parser";
import { parseOwnedPackage, parseOwnedPackagePage, parseOwnedRelease, parseOwnedReleasePage } from './publisher-parser';
import { sitemapShards, sitemapSlugs } from './sitemap-api';

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

async function call(path: string, body?: object, key?: string): Promise<unknown> {
  const response = await fetch(`${origin}${path}`, {
    method: body ? "POST" : "GET",
    headers: { authorization: "Bearer browser-fixture-access-token-that-stays-server-only",
      "content-type": "application/json", ...(key ? { 'idempotency-key': key } : {}) },
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

it('serves created drafts and their navigation contracts through the production parsers', async () => {
  const packagePath = '/v1/me/publishers/11111111-1111-4111-8111-111111111111/packages';
  const releasePath = '/v1/me/packages/22222222-2222-4222-8222-222222222222/releases';
  const body = { slug: 'synthetic-draft', kind: 'capability', visibility: 'private', name: 'Synthetic draft',
    summary: 'Synthetic summary', description: 'Synthetic\r\ntext', tags: ['test'] };
  await call('/fixture/reset-draft-creation-state', {});
  try {
    const denied = await fetch(`${origin}${packagePath}`, { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'idempotency-key': 'synthetic-create-key' },
      signal: AbortSignal.timeout(3_000) });
    expect(denied.status).toBe(401);
    expect(await call('/fixture/draft-creation-state')).toMatchObject({ create_requests: 0, packages: [], releases: [] });
    const created = parseOwnedPackage(await call(packagePath, body, 'synthetic-create-key'));
    expect(created).toMatchObject(body);
    expect(parseOwnedPackage(await call(packagePath, body, 'synthetic-create-key'))).toEqual(created);
    expect(parseOwnedPackage(await call(`/v1/me/packages/${created.id}`))).toEqual(created);
    expect(parseOwnedPackagePage(await call(packagePath)).items.map(item => item.id)).toContain(created.id);
    expect(parseOwnedReleasePage(await call(`/v1/me/packages/${created.id}/releases`)).items).toEqual([]);
    const changed = await fetch(`${origin}${packagePath}`, { method: 'POST', body: JSON.stringify({ ...body, name: 'Changed' }),
      headers: { authorization: 'Bearer browser-fixture-access-token-that-stays-server-only',
        'content-type': 'application/json', 'idempotency-key': 'synthetic-create-key' },
      signal: AbortSignal.timeout(3_000) });
    expect(changed.status).toBe(409);
    const releaseBody = { version: '1.2.3', permissions: ['network.fetch'], compatibility: { products: [] } };
    const release = parseOwnedRelease(await call(releasePath, releaseBody, 'synthetic-release-key'));
    expect(release).toMatchObject(releaseBody);
    expect(parseOwnedRelease(await call(`/v1/me/releases/${release.id}`))).toEqual(release);
    expect(parseOwnedReleasePage(await call(releasePath)).items.map(item => item.id)).toContain(release.id);
    expect(parsePublisherReleaseWorkspace(await call(`/v1/me/releases/${release.id}/workspace`)))
      .toMatchObject({ release_id: release.id, artifacts: [], submission: null, feedback: [], can_upload: true });
    expect(await call('/fixture/draft-creation-state')).toMatchObject({ packages: [created], releases: [release] });
  } finally {
    await call('/fixture/reset-draft-creation-state', {});
  }
  expect(await call('/fixture/draft-creation-state')).toMatchObject({ create_requests: 0, packages: [], releases: [], pending: false });
});

it('serves the discovery fixture through the production bounded HTTP parser', async () => {
  vi.stubEnv('ASSETLIBRARY_API_URL', origin);
  try {
    expect(await sitemapShards()).toEqual(['01']);
    expect(await sitemapSlugs('01')).toEqual(['neuro-starter-art']);
    expect(await sitemapSlugs('ff')).toEqual([]);
    await call('/fixture/discovery-mode?mode=removed', {});
    expect(await sitemapShards()).toEqual([]);
    expect(await sitemapSlugs('01')).toEqual([]);
    await call('/fixture/discovery-mode?mode=unavailable', {});
    await expect(sitemapShards()).rejects.toThrow('unavailable');
  } finally {
    await call('/fixture/discovery-mode?mode=normal', {});
    vi.unstubAllEnvs();
  }
});

it('keeps synthetic release edits immutable, coherent and replayable before stale-revision rejection', async () => {
  const path = '/v1/me/releases/33333333-3333-4333-8333-333333333333';
  await call('/fixture/reset-release-edit', {});
  const original = parseOwnedRelease(await call(path));
  const body = { expected_updated_at: original.updated_at,
    compatibility: { products: [{ name: 'loom', version_requirement: '>=0.2.0' }] }, permissions: ['network.fetch'] };
  const patch = (value: object, key: string, authenticated = true) => fetch(`${origin}${path}`, {
    method: 'PATCH', body: JSON.stringify(value), signal: AbortSignal.timeout(3_000),
    headers: { 'content-type': 'application/json', 'idempotency-key': key,
      ...(authenticated ? { authorization: 'Bearer browser-fixture-access-token-that-stays-server-only' } : {}) },
  });
  const immutable = (value: typeof original) => {
    const { compatibility: _compatibility, permissions: _permissions, updated_at: _updatedAt, ...rest } = value;
    return rest;
  };
  try {
    expect((await patch(body, 'fixture-release-edit-key', false)).status).toBe(401);
    expect(await call('/fixture/release-edit-state')).toMatchObject({ patch_requests: 0, writes: 0, release: original });
    const savedResponse = await patch(body, 'fixture-release-edit-key');
    expect(savedResponse.status).toBe(200);
    const saved = parseOwnedRelease(await savedResponse.json());
    expect(saved).toMatchObject({ compatibility: body.compatibility, permissions: body.permissions });
    expect(saved.updated_at).not.toBe(original.updated_at);
    expect(immutable(saved)).toEqual(immutable(original));
    const reordered = { permissions: body.permissions, compatibility: {
      products: [{ version_requirement: '>=0.2.0', name: 'loom' }] }, expected_updated_at: original.updated_at };
    const replay = await patch(reordered, 'fixture-release-edit-key');
    expect(replay.status).toBe(200);
    expect(parseOwnedRelease(await replay.json())).toEqual(saved);
    expect(await call('/fixture/release-edit-state')).toMatchObject({ writes: 1 });
    const laterResponse = await patch({ ...body, expected_updated_at: saved.updated_at, permissions: ['later.permission'] }, 'fixture-later-key');
    expect(laterResponse.status).toBe(200);
    const later = parseOwnedRelease(await laterResponse.json());
    expect(immutable(later)).toEqual(immutable(original));
    expect(parseOwnedRelease(await (await patch(body, 'fixture-release-edit-key')).json())).toEqual(saved);
    expect((await patch({ ...body, permissions: ['changed.permission'] }, 'fixture-release-edit-key')).status).toBe(409);
    expect((await patch(body, 'fixture-stale-fresh-key')).status).toBe(409);
    expect((await patch({ ...body, version: '9.9.9' }, 'fixture-forged-version-key')).status).toBe(400);
    expect(await call('/fixture/release-edit-state')).toMatchObject({ writes: 2, release: later });
    const history = parseOwnedReleasePage(await call('/v1/me/packages/22222222-2222-4222-8222-222222222222/releases'));
    expect(history.items.find(item => item.id === original.id)).toEqual(later);
  } finally {
    await call('/fixture/reset-release-edit', {});
  }
  expect(await call('/fixture/release-edit-state')).toEqual({ release: original, attempts: [], patch_requests: 0, writes: 0 });
});
