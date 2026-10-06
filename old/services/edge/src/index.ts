import { InvalidRange, parseRange } from "./range";
import { bearerToken, type TicketClaims, verifyTicket } from "./ticket";

interface ObjectHead {
  size: number;
  etag: string;
  httpMetadata?: { contentType?: string };
}
interface ObjectBody extends ObjectHead { body: BodyInit }
interface ObjectStore {
  head(key: string): Promise<ObjectHead | null>;
  get(key: string, options?: { range: { offset: number; length: number } }): Promise<ObjectBody | null>;
}
interface PolicyStore { get(key: string): Promise<string | null> }
interface EventQueue { send(message: unknown): Promise<void> }
interface ExecutionContext { waitUntil(promise: Promise<unknown>): void }
interface RequestTelemetry {
  requestId: string;
  traceId?: string;
  route: "unmatched" | "public_download" | "restricted_download";
  cache: "bypass" | "hit" | "miss";
}
export interface Env {
  PUBLISHED_BUCKET: ObjectStore;
  POLICY: PolicyStore;
  TICKET_SECRET: string;
  TICKET_ISSUER: string;
  TICKET_AUDIENCE: string;
  DOWNLOAD_EVENTS?: EventQueue;
}

interface PublicPolicy {
  publisher_id: string;
  package_id: string;
  release_id: string;
  artifact_id: string;
  signing_key_id: string;
  digest: string;
  object_key: string;
  file_name: string;
}

const routePattern = /^\/(public|restricted)\/sha256\/([a-f0-9]{64})\/([A-Za-z0-9._-]{1,180})$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const traceparentPattern = /^00-([a-f0-9]{32})-([a-f0-9]{16})-[a-f0-9]{2}$/i;

export default {
  async fetch(request: Request, env: Env, context?: ExecutionContext): Promise<Response> {
    const started = performance.now();
    const telemetry = requestTelemetry(request);
    let response: Response;
    try {
      response = await handle(request, env, context, telemetry);
    } catch (cause) {
      logDependencyFailure(telemetry, cause);
      response = error(503, "edge dependency unavailable");
    }
    response = withRequestId(response, telemetry.requestId);
    logRequest(request, telemetry, response.status, performance.now() - started);
    return response;
  },
};

async function handle(
  request: Request,
  env: Env,
  context: ExecutionContext | undefined,
  telemetry: RequestTelemetry,
): Promise<Response> {
  const url = new URL(request.url);
  const route = routePattern.exec(url.pathname);
  if (!route || route[3] === "." || route[3] === "..") return error(404, "not found");
  if (request.method === "OPTIONS") return options();
  if (request.method !== "GET" && request.method !== "HEAD") return error(405, "method not allowed");
  const visibility = route[1];
  const digest = route[2];
  const fileName = route[3];
  if (!visibility || !digest || !fileName) return error(404, "not found");
  telemetry.route = visibility === "public" ? "public_download" : "restricted_download";

  let objectKey: string;
  let subject: PublicPolicy | TicketClaims;
  if (visibility === "public") {
    const policy = await loadPublicPolicy(env.POLICY, digest, fileName);
    if (!policy || await isRevoked(env.POLICY, revocationKeys(policy))) return error(404, "not found");
    objectKey = policy.object_key;
    subject = policy;
    let cached: Response | null = null;
    try {
      cached = await cachedPublic(request, url);
    } catch (cause) {
      logDependencyFailure(telemetry, new DependencyFailure("cache", "read", cause));
    }
    telemetry.cache = cached ? "hit" : "miss";
    if (cached) {
      const response = request.method === "HEAD"
        ? new Response(null, { status: cached.status, headers: cached.headers })
        : cached;
      if (request.method === "GET" && (response.status === 200 || response.status === 206)) {
        recordDownload(env, context, subject, visibility, response, telemetry, true);
      }
      return response;
    }
  } else {
    const token = bearerToken(request);
    if (!token) return error(401, "missing bearer ticket");
    const claims = await verifyTicket(token, env.TICKET_SECRET, {
      issuer: env.TICKET_ISSUER,
      audience: env.TICKET_AUDIENCE,
      path: url.pathname,
      digest,
      now: Math.floor(Date.now() / 1000),
    });
    if (!claims) return error(403, "invalid bearer ticket");
    if (await isRevoked(env.POLICY, revocationKeys(claims))) return error(403, "revoked bearer ticket");
    objectKey = claims.object_key;
    subject = claims;
  }
  const response = await serve(request, env.PUBLISHED_BUCKET, objectKey, digest, fileName, visibility);
  if (visibility === "public" && request.method === "GET" && !request.headers.has("range") && response.status === 200) {
    try {
      await storePublic(url, response.clone());
    } catch (cause) {
      logDependencyFailure(telemetry, new DependencyFailure("cache", "write", cause));
    }
  }
  if (request.method === "GET" && (response.status === 200 || response.status === 206)) {
    recordDownload(env, context, subject, visibility, response, telemetry, false);
  }
  return response;
}

function recordDownload(
  env: Env,
  context: ExecutionContext | undefined,
  subject: PublicPolicy | TicketClaims,
  visibility: string,
  response: Response,
  telemetry: RequestTelemetry,
  cacheHit: boolean,
): void {
  if (!env.DOWNLOAD_EVENTS) return;
  const contentRange = response.headers.get("content-range");
  const rangeStart = contentRange?.match(/^bytes ([0-9]+)-/)?.[1];
  const task = env.DOWNLOAD_EVENTS.send({
    schema_version: "1.0",
    event_id: crypto.randomUUID(),
    occurred_at: new Date().toISOString(),
    publisher_id: subject.publisher_id,
    package_id: subject.package_id,
    release_id: subject.release_id,
    artifact_id: subject.artifact_id,
    digest: subject.digest,
    visibility,
    session_id: isTicketClaims(subject) ? subject.session_id : null,
    client_type: isTicketClaims(subject) ? subject.client_type : null,
    range_start: rangeStart === undefined ? 0 : Number(rangeStart),
    bytes_served: Number(response.headers.get("content-length") ?? "0"),
    correlation_id: telemetry.requestId,
    ...(telemetry.traceId ? { trace_id: telemetry.traceId } : {}),
    cache_hit: cacheHit,
  }).catch((cause: unknown) => {
    logDependencyFailure(telemetry, new DependencyFailure("download_events", "send", cause));
  });
  if (context) context.waitUntil(task);
  else void task;
}

async function loadPublicPolicy(store: PolicyStore, digest: string, fileName: string): Promise<PublicPolicy | null> {
  const raw = await dependency("policy", "public_policy", () => store.get(`public:${digest}`));
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isPublicPolicy(value)) return null;
    const key = `sha256/${digest.slice(0, 2)}/${digest}`;
    return value.digest === digest && value.object_key === key && value.file_name === fileName ? value : null;
  } catch {
    return null;
  }
}

function isPublicPolicy(value: unknown): value is PublicPolicy {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys: ReadonlyArray<keyof PublicPolicy> = ["publisher_id", "package_id", "release_id", "artifact_id",
    "signing_key_id", "digest", "object_key", "file_name"];
  return Object.keys(record).length === keys.length
    && keys.every((key) => typeof record[key] === "string")
    && [record.publisher_id, record.package_id, record.release_id, record.artifact_id]
      .every((id) => typeof id === "string" && uuidPattern.test(id))
    && typeof record.signing_key_id === "string" && /^[!-~]{1,200}$/.test(record.signing_key_id)
    && typeof record.digest === "string" && /^[a-f0-9]{64}$/.test(record.digest)
    && typeof record.object_key === "string" && record.object_key.length <= 1024
    && typeof record.file_name === "string" && /^[A-Za-z0-9._-]{1,180}$/.test(record.file_name);
}

function revocationKeys(value: PublicPolicy | TicketClaims): string[] {
  return [
    `revoked:publisher:${value.publisher_id}`,
    `revoked:package:${value.package_id}`,
    `revoked:release:${value.release_id}`,
    `revoked:artifact:${value.artifact_id}`,
    `revoked:signing_key:${value.publisher_id}:${value.signing_key_id}`,
    `revoked:digest:${value.digest}`,
    ...(isTicketClaims(value) ? [`revoked:session:${value.session_id}`, `revoked:nonce:${value.nonce}`] : []),
  ];
}

function isTicketClaims(value: PublicPolicy | TicketClaims): value is TicketClaims {
  return "session_id" in value;
}

async function isRevoked(store: PolicyStore, keys: string[]): Promise<boolean> {
  const values = await dependency("policy", "revocation", () => Promise.all(keys.map((key) => store.get(key))));
  return values.some((value) => value !== null);
}

async function serve(
  request: Request,
  store: ObjectStore,
  key: string,
  digest: string,
  fileName: string,
  visibility: string,
): Promise<Response> {
  const head = await dependency("r2", "head", () => store.head(key));
  if (!head || head.size <= 0) return error(404, "not found");
  const etag = `"${head.etag || digest}"`;
  if (matchesEtag(request.headers.get("if-none-match"), etag)) {
    return new Response(null, { status: 304, headers: responseHeaders(head, etag, fileName, visibility, head.size) });
  }
  let range;
  try {
    range = parseRange(request.headers.get("range"), head.size);
  } catch (cause) {
    if (!(cause instanceof InvalidRange)) throw cause;
    const headers = corsHeaders();
    headers.set("Content-Range", `bytes */${head.size}`);
    headers.set("Accept-Ranges", "bytes");
    return new Response("range not satisfiable", { status: 416, headers });
  }
  const headers = responseHeaders(head, etag, fileName, visibility, range?.length ?? head.size);
  if (range) headers.set("Content-Range", range.contentRange);
  if (request.method === "HEAD") return new Response(null, { status: range ? 206 : 200, headers });
  const object = await dependency("r2", "get", () =>
    store.get(key, range ? { range: { offset: range.offset, length: range.length } } : undefined));
  if (!object) return error(404, "not found");
  return new Response(object.body, { status: range ? 206 : 200, headers });
}

function responseHeaders(head: ObjectHead, etag: string, fileName: string, visibility: string, length: number): Headers {
  const headers = corsHeaders();
  headers.set("Accept-Ranges", "bytes");
  headers.set("Content-Disposition", `attachment; filename="${fileName}"`);
  headers.set("Content-Length", String(length));
  headers.set("Content-Type", head.httpMetadata?.contentType ?? "application/octet-stream");
  headers.set("ETag", etag);
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Cache-Control", visibility === "public" ? "public, max-age=31536000, immutable" : "private, no-store");
  return headers;
}

function corsHeaders(): Headers {
  return new Headers({
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Authorization, Range, If-None-Match, Traceparent, Tracestate, X-Request-ID",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Expose-Headers": "ETag, Content-Range, Content-Length, X-Request-ID",
  });
}

function options(): Response { return new Response(null, { status: 204, headers: corsHeaders() }); }
function error(status: number, message: string): Response {
  const headers = corsHeaders();
  headers.set("Cache-Control", "no-store");
  return new Response(message, { status, headers });
}
function matchesEtag(candidate: string | null, etag: string): boolean {
  return candidate?.split(",").map((value) => value.trim()).some((value) => value === "*" || value === etag) ?? false;
}

function requestTelemetry(request: Request): RequestTelemetry {
  const candidate = request.headers.get("x-request-id");
  const traceparent = request.headers.get("traceparent")?.trim();
  const traceMatch = traceparentPattern.exec(traceparent ?? "");
  const traceId = traceMatch?.[1]?.toLowerCase();
  const spanId = traceMatch?.[2];
  return {
    requestId: candidate && uuidPattern.test(candidate) ? candidate.toLowerCase() : crypto.randomUUID(),
    ...(traceId && spanId && !/^0+$/.test(traceId) && !/^0+$/.test(spanId) ? { traceId } : {}),
    route: "unmatched",
    cache: "bypass",
  };
}

function withRequestId(response: Response, requestId: string): Response {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", requestId);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function logRequest(request: Request, telemetry: RequestTelemetry, status: number, durationMs: number): void {
  console.log(JSON.stringify({
    event: "edge_request",
    request_id: telemetry.requestId,
    ...(telemetry.traceId ? { trace_id: telemetry.traceId } : {}),
    method: request.method,
    route: telemetry.route,
    cache: telemetry.cache,
    status,
    duration_ms: Math.round(durationMs),
  }));
}

function logDependencyFailure(telemetry: RequestTelemetry, cause: unknown): void {
  const failure = cause instanceof DependencyFailure ? cause : new DependencyFailure("edge", "request", cause);
  console.error(JSON.stringify({
    event: "edge_dependency_error",
    request_id: telemetry.requestId,
    ...(telemetry.traceId ? { trace_id: telemetry.traceId } : {}),
    route: telemetry.route,
    dependency: failure.dependency,
    operation: failure.operation,
    error_type: failure.causeName,
  }));
}

class DependencyFailure extends Error {
  readonly causeName: string;

  constructor(readonly dependency: string, readonly operation: string, cause: unknown) {
    super("edge dependency failure");
    this.name = "DependencyFailure";
    this.causeName = cause instanceof Error ? cause.name : "UnknownError";
  }
}

async function dependency<T>(name: string, operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (cause) {
    throw new DependencyFailure(name, operation, cause);
  }
}

interface EdgeCaches { default: Cache }
function edgeCache(): Cache | null {
  return (globalThis as unknown as { caches?: EdgeCaches }).caches?.default ?? null;
}
export function publicCacheKey(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
async function cachedPublic(request: Request, url: URL): Promise<Response | null> {
  const cache = edgeCache();
  if (!cache || request.headers.has("range") || request.headers.has("if-none-match")) return null;
  return (await cache.match(new Request(publicCacheKey(url), { method: "GET" }))) ?? null;
}
async function storePublic(url: URL, response: Response): Promise<void> {
  const cache = edgeCache();
  if (cache) await cache.put(new Request(publicCacheKey(url), { method: "GET" }), response);
}
