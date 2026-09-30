import assert from "node:assert/strict";
import { createHash } from "node:crypto";

const [metadataUrl, expectedRawSha256] = process.argv.slice(2);
assert(metadataUrl && expectedRawSha256 && /^[a-f0-9]{64}$/.test(expectedRawSha256),
  "usage: node Test-Pc2EdgeDownload.ts <public-metadata-url> <raw-sha256>");

async function request(url: string, options: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...options, redirect: "error", signal: AbortSignal.timeout(30_000) });
}

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  assert(response.body);
  const reader = response.body.getReader();
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      assert(size <= limit, "response exceeds the bounded acceptance fixture size");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

const metadataResponse = await request(metadataUrl);
assert.equal(metadataResponse.status, 200);
const metadata: unknown = JSON.parse((await boundedBytes(metadataResponse, 64 * 1024)).toString());
assert(metadata && typeof metadata === "object");
assert("download_url" in metadata && typeof metadata.download_url === "string");
assert("artifact" in metadata && metadata.artifact && typeof metadata.artifact === "object");
const artifact = metadata.artifact;
assert("size_bytes" in artifact && typeof artifact.size_bytes === "number");
assert(Number.isSafeInteger(artifact.size_bytes) && artifact.size_bytes > 32 && artifact.size_bytes <= 1024 * 1024);
assert("digest" in artifact && typeof artifact.digest === "string" && /^[a-f0-9]{64}$/.test(artifact.digest));
const url = new URL(metadata.download_url);
assert.equal(url.protocol, "https:");
assert.equal(url.search, "");
assert.equal(url.username, "");
assert.equal(url.password, "");
assert(url.pathname.startsWith(`/public/sha256/${artifact.digest}/`));

const full = await request(url.href);
assert.equal(full.status, 200);
assert.equal(full.headers.get("content-length"), String(artifact.size_bytes));
assert.equal(full.headers.get("accept-ranges"), "bytes");
assert.equal(full.headers.get("x-content-type-options"), "nosniff");
assert(full.headers.get("cache-control")?.includes("immutable"));
const bytes = await boundedBytes(full, artifact.size_bytes);
assert.equal(bytes.length, artifact.size_bytes);
assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedRawSha256);
const etag = full.headers.get("etag");
assert(etag);

// Run Range and conditional requests after warming the public full-response cache.
const range = await request(url.href, { headers: { Range: "bytes=0-31" } });
assert.equal(range.status, 206);
assert.equal(range.headers.get("content-range"), `bytes 0-31/${bytes.length}`);
assert.deepEqual(await boundedBytes(range, 32), bytes.subarray(0, 32));
const suffix = await request(url.href, { headers: { Range: "bytes=-16" } });
assert.equal(suffix.status, 206);
assert.deepEqual(await boundedBytes(suffix, 16), bytes.subarray(-16));

const head = await request(url.href, { method: "HEAD" });
assert.equal(head.status, 200);
assert.equal(head.headers.get("content-length"), String(bytes.length));
assert.equal((await head.arrayBuffer()).byteLength, 0);
const conditional = await request(url.href, { headers: { "If-None-Match": etag } });
assert.equal(conditional.status, 304);
assert.equal((await conditional.arrayBuffer()).byteLength, 0);
const invalid = await request(url.href, { headers: { Range: `bytes=${bytes.length}-` } });
assert.equal(invalid.status, 416);
assert.equal(invalid.headers.get("content-range"), `bytes */${bytes.length}`);
await boundedBytes(invalid, 1024);

const missing = new URL(url);
missing.pathname = missing.pathname.replace(artifact.digest, "0".repeat(64));
const denied = await request(missing.href);
assert.equal(denied.status, 404);
await boundedBytes(denied, 1024);
const restricted = new URL(url);
restricted.pathname = restricted.pathname.replace("/public/", "/restricted/");
const anonymous = await request(restricted.href);
assert.equal(anonymous.status, 401);
await boundedBytes(anonymous, 1024);
const tampered = await request(restricted.href, { headers: { Authorization: "Bearer invalid-acceptance-ticket" } });
assert.equal(tampered.status, 403);
await boundedBytes(tampered, 1024);

console.log(JSON.stringify({
  verified_at_utc: new Date().toISOString(),
  metadata_url: metadataUrl,
  download_origin: url.origin,
  bytes: bytes.length,
  raw_sha256: expectedRawSha256,
  canonical_sha256: artifact.digest,
  checks: {
    metadata: 200, full_get: 200, range: 206, suffix_range: 206, head: 200,
    conditional_get: 304, invalid_range: 416, missing_policy: 404,
    restricted_anonymous: 401, restricted_invalid_ticket: 403,
  },
  production_acceptance: false,
}));
