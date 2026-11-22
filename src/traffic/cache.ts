/** 公开只读接口与静态资源的 ETag（304）及有界边缘缓存；私有业务与包体下载永不进入此层。 */
export interface TrafficCacheEnv {
  PUBLIC_EDGE_CACHE_SECONDS?: string;
  COVER_EDGE_CACHE_SECONDS?: string;
}

const MAX_IF_NONE_MATCH_LENGTH = 512;

export function parseEdgeTtl(raw: string | undefined, maxSeconds: number): number {
  if (!raw) return 0;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) return 0;
  return Math.min(parsed, maxSeconds);
}

export async function etagOf(payload: string | Uint8Array): Promise<string> {
  const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy);
  const hex = Array.from(new Uint8Array(digest).subarray(0, 16), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `"${hex}"`;
}

function normalizeTag(tag: string): string {
  const trimmed = tag.trim();
  return trimmed.startsWith("W/") ? trimmed.slice(2).trim() : trimmed;
}

export function ifNoneMatch(request: Request, etag: string): boolean {
  if (!["GET", "HEAD"].includes(request.method)) return false;
  const header = request.headers.get("if-none-match");
  if (!header || header.length > MAX_IF_NONE_MATCH_LENGTH) return false;
  if (header.trim() === "*") return true;
  const target = normalizeTag(etag);
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < header.length; i++) {
    const ch = header[i] ?? "";
    if (ch === '"') inQuotes = !inQuotes;
    if (ch === "," && !inQuotes) {
      if (normalizeTag(current) === target) return true;
      current = "";
    } else {
      current += ch;
    }
  }
  return normalizeTag(current) === target;
}

export function notModified(headers: HeadersInit): Response {
  const filtered = new Headers(headers);
  filtered.delete("Content-Type");
  filtered.delete("Content-Length");
  return new Response(null, { status: 304, headers: filtered });
}

export function publicCacheHeader(maxAge: number, sMaxAge: number, swr: number): string {
  return `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`;
}

export async function cachedPublicJson(
  request: Request,
  response: Response,
  maxAge = 5,
  sMaxAge = 10,
  swr = 20,
): Promise<Response> {
  if (response.status !== 200 || !["GET", "HEAD"].includes(request.method)) return response;
  const text = await response.text();
  const etag = await etagOf(text);
  const headers = new Headers(response.headers);
  headers.set("ETag", etag);
  headers.set("Cache-Control", publicCacheHeader(maxAge, sMaxAge, swr));
  headers.set("X-Content-Type-Options", "nosniff");
  if (ifNoneMatch(request, etag)) return notModified(headers);
  return new Response(request.method === "HEAD" ? null : text, { status: 200, headers });
}

function defaultEdgeCache(): Cache | null {
  const storage = (globalThis as { caches?: { default?: Cache } }).caches;
  return storage?.default ?? null;
}

/**
 * 仅对匿名公开 GET/HEAD 启用 Cloudflare 边缘短缓存。
 * 缓存键剥离所有客户端请求头，杜绝带凭据请求污染或按 Cookie 分裂。
 */
export async function withPublicEdgeCache(
  request: Request,
  ttlSeconds: number,
  compute: (upstreamRequest: Request) => Promise<Response>,
  ctx?: ExecutionContext,
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method) || ttlSeconds <= 0) {
    return compute(request);
  }
  const cache = defaultEdgeCache();
  if (!cache) return compute(request);

  const url = new URL(request.url);
  const cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const headers = new Headers(hit.headers);
    headers.set("X-Traffic-Cache", "HIT");
    const etag = headers.get("ETag");
    if (etag && ifNoneMatch(request, etag)) return notModified(headers);
    if (request.method === "HEAD") {
      await hit.body?.cancel().catch(() => {});
      return new Response(null, { status: hit.status, headers });
    }
    return new Response(hit.body, { status: hit.status, headers });
  }

  const upstream = await compute(new Request(url.toString(), { method: "GET" }));
  if (upstream.status !== 200) return upstream;

  const storeClone = upstream.clone();
  const storePromise = cache.put(cacheKey, storeClone).catch(() => {});
  if (ctx) ctx.waitUntil(storePromise);
  else await storePromise;

  const headers = new Headers(upstream.headers);
  headers.set("X-Traffic-Cache", "MISS");
  const etag = headers.get("ETag");
  if (etag && ifNoneMatch(request, etag)) {
    await upstream.body?.cancel().catch(() => {});
    return notModified(headers);
  }
  if (request.method === "HEAD") {
    await upstream.body?.cancel().catch(() => {});
    return new Response(null, { status: 200, headers });
  }
  return new Response(upstream.body, { status: 200, headers });
}
