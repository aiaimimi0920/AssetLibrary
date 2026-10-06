import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, publicCacheKey } from "../src/index";
import type { TicketClaims } from "../src/ticket";

const digest = "ab".repeat(32);
const bytes = new TextEncoder().encode("0123456789");
const ids = {
  publisher_id: "11111111-1111-4111-8111-111111111111",
  package_id: "22222222-2222-4222-8222-222222222222",
  release_id: "33333333-3333-4333-8333-333333333333",
  artifact_id: "44444444-4444-4444-8444-444444444444",
};
const fileName = "fixture-1.0.0.zip";
const objectKey = `sha256/${digest.slice(0, 2)}/${digest}`;
const secretBytes = new Uint8Array(32).fill(42);
const secret = base64Url(secretBytes);

class Store {
  async head(key: string) {
    return key === objectKey ? { size: bytes.length, etag: digest, httpMetadata: { contentType: "application/zip" } } : null;
  }
  async get(key: string, options?: { range: { offset: number; length: number } }) {
    if (key !== objectKey) return null;
    const body = options ? bytes.slice(options.range.offset, options.range.offset + options.range.length) : bytes;
    return { size: bytes.length, etag: digest, httpMetadata: { contentType: "application/zip" }, body };
  }
}

class Policy {
  readonly values = new Map<string, string>();
  async get(key: string) { return this.values.get(key) ?? null; }
}

let policy: Policy;
let env: Env;
let events: unknown[];
beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  events = [];
  policy = new Policy();
  policy.values.set(`public:${digest}`, JSON.stringify({
    ...ids, signing_key_id: "fixture-key", digest, object_key: objectKey, file_name: fileName,
  }));
  env = {
    PUBLISHED_BUCKET: new Store(), POLICY: policy, TICKET_SECRET: secret,
    TICKET_ISSUER: "assetlibrary-test", TICKET_AUDIENCE: "edge-test",
    DOWNLOAD_EVENTS: { async send(message) { events.push(message); } },
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  Reflect.deleteProperty(globalThis, "caches");
});

describe("public immutable downloads", () => {
  it("serves GET, HEAD, ETag, and safe cache headers", async () => {
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    const requestId = "77777777-7777-4777-8777-777777777777";
    const traceId = "11".repeat(16);
    const response = await worker.fetch(new Request(url, { headers: {
      "X-Request-ID": requestId,
      traceparent: `00-${traceId}-${"22".repeat(8)}-01`,
    } }), env);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("0123456789");
    expect(response.headers.get("cache-control")).toContain("immutable");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("x-request-id")).toBe(requestId);
    expect(response.headers.get("access-control-expose-headers")).toContain("X-Request-ID");
    await Promise.resolve();
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty("access_token");
    expect(events[0]).toMatchObject({ correlation_id: requestId, trace_id: traceId, cache_hit: false });
    const head = await worker.fetch(new Request(url, { method: "HEAD" }), env);
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const unchanged = await worker.fetch(new Request(url, { headers: { "If-None-Match": `"${digest}"` } }), env);
    expect(unchanged.status).toBe(304);
  });

  it("supports resumable single ranges and rejects multi-range", async () => {
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    const partial = await worker.fetch(new Request(url, { headers: { Range: "bytes=2-5" } }), env);
    expect(partial.status).toBe(206);
    expect(partial.headers.get("content-range")).toBe("bytes 2-5/10");
    expect(await partial.text()).toBe("2345");
    const suffix = await worker.fetch(new Request(url, { headers: { Range: "bytes=-3" } }), env);
    expect(await suffix.text()).toBe("789");
    const invalid = await worker.fetch(new Request(url, { headers: { Range: "bytes=0-1,4-5" } }), env);
    expect(invalid.status).toBe(416);
    expect(invalid.headers.get("content-range")).toBe("bytes */10");
  });

  it("checks allowlist and revocation before serving bytes", async () => {
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    policy.values.set(`revoked:artifact:${ids.artifact_id}`, "1");
    expect((await worker.fetch(new Request(url), env)).status).toBe(404);
    policy.values.delete(`revoked:artifact:${ids.artifact_id}`);
    policy.values.delete(`public:${digest}`);
    expect((await worker.fetch(new Request(url), env)).status).toBe(404);
  });

  it("rejects malformed policy identities and ignores analytics failure", async () => {
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    const original = policy.values.get(`public:${digest}`)!;
    policy.values.set(`public:${digest}`, original.replace(ids.publisher_id, "not-a-uuid"));
    expect((await worker.fetch(new Request(url), env)).status).toBe(404);
    policy.values.set(`public:${digest}`, original);
    env.DOWNLOAD_EVENTS = { async send() { throw new Error("analytics unavailable"); } };
    expect((await worker.fetch(new Request(url), env)).status).toBe(200);
    await Promise.resolve();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('"dependency":"download_events"'));
  });

  it("rejects a prepared public URL after revocation even when bytes are in the edge cache", async () => {
    const cached = vi.fn().mockResolvedValue(new Response(bytes));
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: { match: cached } } });
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    expect((await worker.fetch(new Request(url), env)).status).toBe(200);
    expect(cached).toHaveBeenCalledTimes(1);
    policy.values.set(`revoked:artifact:${ids.artifact_id}`, "1");
    const denied = await worker.fetch(new Request(url), env);
    expect(denied.status).toBe(404);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    expect(cached).toHaveBeenCalledTimes(1);
  });

  it("counts cache-hit GETs without caching request correlation data", async () => {
    const stored = new Map<string, Response>();
    Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: {
      async match(request: Request) { return stored.get(request.url)?.clone(); },
      async put(request: Request, response: Response) { stored.set(request.url, response.clone()); },
    } } });
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    const first = await worker.fetch(new Request(url), env);
    expect(await first.text()).toBe("0123456789");
    const secondId = "88888888-8888-4888-8888-888888888888";
    const second = await worker.fetch(new Request(url, { headers: { "X-Request-ID": secondId } }), env);
    expect(await second.text()).toBe("0123456789");
    await Promise.resolve();
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ correlation_id: secondId, cache_hit: true });
    expect(second.headers.get("x-request-id")).toBe(secondId);
  });

  it("returns a correlation ID and safe log when R2 fails", async () => {
    env.PUBLISHED_BUCKET = {
      async head() { throw new TypeError("internal bucket detail"); },
      async get() { return null; },
    };
    const url = `https://download.test/public/sha256/${digest}/${fileName}`;
    const response = await worker.fetch(new Request(url, { headers: { "X-Request-ID": "not-safe" } }), env);
    expect(response.status).toBe(503);
    expect(response.headers.get("x-request-id")).toMatch(uuidPatternForTest);
    expect(await response.text()).toBe("edge dependency unavailable");
    const failure = vi.mocked(console.error).mock.calls.at(-1)?.[0];
    expect(failure).toContain('"dependency":"r2"');
    expect(failure).toContain('"operation":"head"');
    expect(failure).not.toContain("internal bucket detail");
  });
});

describe("restricted tickets", () => {
  it("binds signature, path, audience, expiry, and revocation", async () => {
    const path = `/restricted/sha256/${digest}/${fileName}`;
    const claims = claimsFor(path);
    const token = await sign(claims);
    const request = () => new Request(`https://download.test${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const swapped = new Request(`https://download.test${path.replace(fileName, "other.zip")}`, { headers: { Authorization: `Bearer ${token}` } });
    expect((await worker.fetch(swapped, env)).status).toBe(403);
    const signatureOffset = token.lastIndexOf(".") + 1;
    const replacement = token[signatureOffset] === "A" ? "B" : "A";
    const bad = `${token.slice(0, signatureOffset)}${replacement}${token.slice(signatureOffset + 1)}`;
    expect((await worker.fetch(new Request(`https://download.test${path}`, { headers: { Authorization: `Bearer ${bad}` } }), env)).status).toBe(403);
    policy.values.set(`revoked:session:${claims.session_id}`, "1");
    expect((await worker.fetch(request(), env)).status).toBe(403);
  });

  it("rejects expired tickets", async () => {
    const path = `/restricted/sha256/${digest}/${fileName}`;
    const claims = claimsFor(path);
    claims.issued_at -= 1000;
    claims.not_before -= 1000;
    claims.expires_at -= 1000;
    const token = await sign(claims);
    const response = await worker.fetch(new Request(`https://download.test${path}`, { headers: { Authorization: `Bearer ${token}` } }), env);
    expect(response.status).toBe(403);
  });
});

it("cache identity excludes query tickets and request headers", () => {
  const url = new URL(`https://download.test/public/sha256/${digest}/${fileName}?ticket=secret`);
  expect(publicCacheKey(url)).toBe(`https://download.test${url.pathname}`);
});

function claimsFor(path: string): TicketClaims {
  const now = Math.floor(Date.now() / 1000);
  return {
    issuer: "assetlibrary-test", audience: "edge-test", purpose: "download",
    session_id: "55555555-5555-4555-8555-555555555555", ...ids,
    signing_key_id: "fixture-key", client_type: "loom", digest, object_key: objectKey, path,
    nonce: "66666666-6666-4666-8666-666666666666",
    issued_at: now, not_before: now - 5, expires_at: now + 300,
  };
}

async function sign(claims: TicketClaims): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(claims)));
  const key = await crypto.subtle.importKey("raw", new Uint8Array(secretBytes).buffer, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`v1.${payload}`)));
  return `v1.${payload}.${base64Url(signature)}`;
}

function base64Url(value: Uint8Array): string {
  let binary = "";
  value.forEach((byte) => { binary += String.fromCharCode(byte); });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

const uuidPatternForTest = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
