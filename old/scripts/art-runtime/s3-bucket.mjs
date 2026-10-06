import { createHash, createHmac } from "node:crypto";

const maximumObjectBytes = 32 * 1024 * 1024;
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const hmac = (key, value) => createHmac("sha256", key).update(value).digest();

export function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Test endpoints must be explicit HTTP loopback origins");
  }
  return url.origin;
}

// A test-only R2 port backed by authenticated, run-owned MinIO HEAD/GET.
// This adapter cannot read quarantine, arbitrary paths or remote endpoints.
export function createPublishedBucket(settings) {
  const origin = loopbackOrigin(settings.origin);
  if (settings.bucket !== "assetlibrary-published" || settings.accessKey !== "isolated-scanner"
    || !/^[a-f0-9]{48}$/.test(settings.secretKey)) throw new Error("Invalid test storage settings");

  async function request(method, key, range) {
    const match = /^sha256\/([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(key);
    if (!match || match[1] !== match[2].slice(0, 2)) throw new Error("Invalid published object key");
    const url = new URL(`/${settings.bucket}/${key}`, origin);
    const timestamp = new Date().toISOString().replace(/[:-]|\.\d{3}/g, "");
    const date = timestamp.slice(0, 8);
    const payloadHash = sha256("");
    const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${timestamp}\n`;
    const names = "host;x-amz-content-sha256;x-amz-date";
    const canonicalRequest = [method, url.pathname, "", canonicalHeaders, names, payloadHash].join("\n");
    const scope = `${date}/us-east-1/s3/aws4_request`;
    const signingKey = hmac(hmac(hmac(hmac(`AWS4${settings.secretKey}`, date), "us-east-1"), "s3"), "aws4_request");
    const signature = createHmac("sha256", signingKey)
      .update(`AWS4-HMAC-SHA256\n${timestamp}\n${scope}\n${sha256(canonicalRequest)}`).digest("hex");
    const headers = {
      "x-amz-content-sha256": payloadHash, "x-amz-date": timestamp,
      authorization: `AWS4-HMAC-SHA256 Credential=${settings.accessKey}/${scope}, SignedHeaders=${names}, Signature=${signature}`,
    };
    if (range) {
      if (!Number.isSafeInteger(range.offset) || !Number.isSafeInteger(range.length)
        || range.offset < 0 || range.length < 1 || range.offset + range.length > maximumObjectBytes) {
        throw new Error("Invalid test storage range");
      }
      headers.range = `bytes=${range.offset}-${range.offset + range.length - 1}`;
    }
    const response = await fetch(url, {
      method, headers, redirect: "error", signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404) { await response.body?.cancel(); return null; }
    if (response.status !== (range ? 206 : 200)) {
      await response.body?.cancel();
      throw new Error("Authenticated test storage read failed");
    }
    const size = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(size) || size < 1 || size > maximumObjectBytes) {
      await response.body?.cancel(); throw new Error("Test storage object exceeds bound");
    }
    return {
      size, etag: response.headers.get("etag")?.replace(/^"|"$/g, "") ?? "",
      httpMetadata: { contentType: response.headers.get("content-type") ?? "application/zip" },
      body: response.body,
    };
  }
  return {
    head: (key) => request("HEAD", key),
    get: (key, options) => request("GET", key, options?.range),
  };
}
