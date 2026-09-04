import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

const port = Number(process.env.ASSETLIBRARY_BROWSER_FIXTURE_PORT ?? "18900");
const token = "browser-fixture-access-token-that-stays-server-only";
const sessionCookie = "neuro_session=browser-fixture-session";
const webOrigin = `http://127.0.0.1:${Number(process.env.ASSETLIBRARY_BROWSER_WEB_PORT ?? "18901")}`;

async function fixture(name) {
  return JSON.parse(await readFile(new URL(`../../../contracts/fixtures/${name}`, import.meta.url), "utf8"));
}

const [packages, memberships, signingKeys, ownedPackages, ownedReleases, workspaceFixture] = await Promise.all([
  fixture("package-page.v1.json"),
  fixture("publisher-membership-page.v1.json"),
  fixture("publisher-signing-key-page.v1.json"),
  fixture("owned-package-page.v1.json"),
  fixture("owned-release-page.v1.json"),
  fixture("publisher-release-workspace.v1.json"),
]);
let ownedPackage = { ...ownedPackages.items[0], description: "Browser editable package details." };
const ownedRelease = ownedReleases.items[0];
const uploadSessionId = "77777777-7777-4777-8777-777777777777";
const uploadArtifactId = "88888888-8888-4888-8888-888888888888";
let upload = null;
let delayedSecondPart = false;

function send(response, status, body, cacheControl = "no-store") {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": cacheControl,
  });
  response.end(JSON.stringify(body));
}

function authorized(request) {
  return request.headers.authorization === `Bearer ${token}`;
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function cors(response, status, headers = {}) {
  response.writeHead(status, {
    "access-control-allow-origin": webOrigin,
    "access-control-allow-methods": "PUT, OPTIONS",
    "access-control-allow-headers": "content-type, x-amz-checksum-sha256",
    "access-control-expose-headers": "ETag",
    ...headers,
  });
}

function publicSession() {
  return { id: upload.id, release_id: upload.release_id, artifact_id: upload.artifact_id,
    part_size_bytes: upload.part_size_bytes, max_parts: upload.max_parts,
    expires_at_epoch_seconds: upload.expires_at_epoch_seconds,
    status: upload.status, expected_digest: upload.expected_digest };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${port}`);
  if (request.method === "GET" && url.pathname === "/healthz") return send(response, 200, { status: "ok" });
  if (request.method === "GET" && url.pathname === "/fixture/upload-state") {
    return send(response, 200, { parts: upload ? [...upload.parts.keys()].sort((a, b) => a - b) : [] });
  }
  if (request.method === "POST" && url.pathname === "/fixture/reset-upload") {
    upload = null;
    delayedSecondPart = false;
    return send(response, 200, { reset: true });
  }
  const objectPart = url.pathname.match(/^\/fixture-upload\/([0-9a-f-]+)\/(\d+)$/i);
  if (objectPart && request.method === "OPTIONS") {
    cors(response, 204);
    return response.end();
  }
  if (objectPart && request.method === "PUT") {
    const partNumber = Number(objectPart[2]);
    const targetUpload = upload;
    if (!targetUpload || objectPart[1] !== targetUpload.id
      || partNumber < 1 || partNumber > targetUpload.max_parts) {
      cors(response, 404);
      return response.end();
    }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const bytes = Buffer.concat(chunks);
    const checksum = createHash("sha256").update(bytes).digest("base64");
    if (request.headers["x-amz-checksum-sha256"] !== checksum) {
      cors(response, 400);
      return response.end();
    }
    if (partNumber === 2 && !delayedSecondPart) {
      delayedSecondPart = true;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      if (response.destroyed || upload !== targetUpload) return;
    }
    const etag = `"fixture-part-${partNumber}"`;
    targetUpload.parts.set(partNumber, { part_number: partNumber, etag,
      checksum_sha256_base64: checksum, size_bytes: bytes.length });
    cors(response, 200, { etag });
    return response.end();
  }
  if (request.method === "GET" && url.pathname === "/v1/public/packages") {
    return send(response, 200, packages, "public, max-age=60");
  }
  if (request.method === "GET" && url.pathname === "/v1/session") {
    if (!request.headers.cookie?.split(/;\s*/).includes(sessionCookie)) {
      return send(response, 401, { error: "unauthenticated" });
    }
    return send(response, 200, {
      principal: { issuer: "https://accounts.browser.invalid", subject: "browser-private-subject" },
      access_token: token,
      expires_at: "2099-01-01T00:00:00Z",
    }, "private, no-store");
  }
  if (!authorized(request)) return send(response, 401, { error: "unauthenticated" });
  if (request.method === "GET" && url.pathname === "/v1/me/publishers") {
    return send(response, 200, memberships, "private, no-store");
  }
  if (request.method === "GET"
    && url.pathname === "/v1/me/publishers/11111111-1111-4111-8111-111111111111/signing-keys") {
    return send(response, 200, signingKeys, "private, no-store");
  }
  if (url.pathname === `/v1/me/packages/${ownedPackage.id}`) {
    if (request.method === "GET") return send(response, 200, ownedPackage, "private, no-store");
    if (request.method === "PATCH") {
      const body = await jsonBody(request);
      if (body.expected_updated_at !== ownedPackage.updated_at) {
        return send(response, 409, { error: "conflict" });
      }
      ownedPackage = {
        ...ownedPackage,
        visibility: body.visibility,
        name: body.name,
        summary: body.summary,
        description: body.description,
        tags: body.tags,
        updated_at: new Date().toISOString(),
      };
      return send(response, 200, ownedPackage, "private, no-store");
    }
  }
  if (request.method === "GET" && url.pathname === `/v1/me/packages/${ownedPackage.id}/releases`) {
    return send(response, 200, ownedReleases, "private, no-store");
  }
  if (request.method === "GET" && url.pathname === `/v1/me/releases/${ownedRelease.id}`) {
    return send(response, 200, ownedRelease, "private, no-store");
  }
  if (request.method === "GET" && url.pathname === `/v1/me/releases/${ownedRelease.id}/workspace`) {
    return send(response, 200, { ...workspaceFixture, artifacts: [], submission: null,
      feedback: [], can_upload: true }, "private, no-store");
  }
  if (request.method === "POST"
    && url.pathname === `/v1/me/releases/${ownedRelease.id}/upload-sessions`) {
    const body = await jsonBody(request);
    upload = { id: uploadSessionId, release_id: ownedRelease.id, artifact_id: uploadArtifactId,
      object_key: `quarantine/${ownedRelease.id}/${uploadArtifactId}/${body.file_name}`,
      part_size_bytes: body.part_size_bytes, max_parts: body.part_count, size_bytes: body.size_bytes,
      expires_at_epoch_seconds: Math.floor(Date.now() / 1_000) + 3_600,
      status: "pending_upload", expected_digest: body.expected_digest, parts: new Map() };
    delayedSecondPart = false;
    return send(response, 200, { ...publicSession(), object_key: upload.object_key }, "private, no-store");
  }
  if (request.method === "GET" && url.pathname === `/v1/me/upload-sessions/${uploadSessionId}`) {
    if (!upload) return send(response, 404, { error: "not_found" });
    return send(response, 200, { ...publicSession(), size_bytes: upload.size_bytes,
      uploaded_parts: [...upload.parts.values()].sort((a, b) => a.part_number - b.part_number) },
    "private, no-store");
  }
  const presign = url.pathname.match(/^\/v1\/me\/upload-sessions\/([0-9a-f-]+)\/parts\/(\d+)$/i);
  if (request.method === "POST" && presign) {
    if (!upload || presign[1] !== upload.id) return send(response, 404, { error: "not_found" });
    const body = await jsonBody(request);
    const partNumber = Number(presign[2]);
    return send(response, 200, { part_number: partNumber, method: "PUT",
      url: `http://127.0.0.1:${port}/fixture-upload/${upload.id}/${partNumber}`,
      headers: { "x-amz-checksum-sha256": body.checksum_sha256_base64 },
      expires_in_seconds: 900 }, "private, no-store");
  }
  if (request.method === "POST" && url.pathname === `/v1/me/upload-sessions/${uploadSessionId}/complete`) {
    const body = await jsonBody(request);
    if (!upload || body.parts.length !== upload.max_parts) return send(response, 409, { error: "conflict" });
    upload.status = "uploaded";
    return send(response, 200, { ...publicSession(), object_key: upload.object_key }, "private, no-store");
  }
  if (!["GET", "PATCH"].includes(request.method ?? "")) {
    return send(response, 405, { error: "method_not_allowed" });
  }
  return send(response, 404, { error: "not_found" });
});

server.listen(port, "127.0.0.1", () => {
  console.log(`browser fixture listening on 127.0.0.1:${port}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
