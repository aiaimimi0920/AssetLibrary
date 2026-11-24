/** 公开只读接口与静态资源的 ETag（304）、边缘 SWR 后台刷新及写操作本机房即时失效。 */
export interface TrafficCacheEnv {
  PUBLIC_EDGE_CACHE_SECONDS?: string;
  COVER_EDGE_CACHE_SECONDS?: string;
}

const MAX_IF_NONE_MATCH_LENGTH = 512;
const INTERNAL_FRESH_UNTIL = "X-Edge-Fresh-Until";
const INTERNAL_DOWNSTREAM_CC = "X-Downstream-Cache-Control";
const inflightRefreshes = new Set<string>();

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
  filtered.delete(INTERNAL_FRESH_UNTIL);
  filtered.delete(INTERNAL_DOWNSTREAM_CC);
  return new Response(null, { status: 304, headers: filtered });
}

export function publicCacheHeader(maxAge: number, sMaxAge: number, swr: number): string {
  return `public, max-age=${maxAge}, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`;
}

export async function cachedPublicJson(
  request: Request,
  response: Response,
  maxAge = 5,
  sMaxAge = 60,
  swr = 300,
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

async function putIntoEdgeCache(
  cache: Cache,
  cacheKey: Request,
  upstream: Response,
  freshSeconds: number,
  now: number,
): Promise<void> {
  const swrSeconds = Math.min(freshSeconds * 5, 600);
  const storedHeaders = new Headers(upstream.headers);
  const downstreamCc = storedHeaders.get("Cache-Control") ?? "";
  if (downstreamCc) storedHeaders.set(INTERNAL_DOWNSTREAM_CC, downstreamCc);
  storedHeaders.set(INTERNAL_FRESH_UNTIL, String(now + freshSeconds * 1000));
  storedHeaders.set("Cache-Control", `public, s-maxage=${freshSeconds + swrSeconds}`);
  const storedResponse = new Response(upstream.body, { status: 200, headers: storedHeaders });
  await cache.put(cacheKey, storedResponse).catch(() => {});
}

/**
 * 对匿名公开 GET/HEAD 启用 Cloudflare 边缘缓存与后台异步 SWR 刷新：
 * - 新鲜期内（freshSeconds）直接返回 HIT；
 * - SWR 窗口内（最长 5x freshSeconds）0 毫秒返回 STALE，并通过 waitUntil 单飞异步回源更新；
 * - 缓存键剥离所有客户端请求头，杜绝带凭据污染。
 */
export async function withPublicEdgeCache(
  request: Request,
  freshSeconds: number,
  compute: (upstreamRequest: Request) => Promise<Response>,
  ctx?: ExecutionContext,
  now = Date.now(),
): Promise<Response> {
  if (!["GET", "HEAD"].includes(request.method) || freshSeconds <= 0) {
    return compute(request);
  }
  const cache = defaultEdgeCache();
  if (!cache) return compute(request);

  const canonicalUrl = new URL(request.url).toString();
  const cacheKey = new Request(canonicalUrl, { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) {
    const freshUntil = Number(hit.headers.get(INTERNAL_FRESH_UNTIL) ?? "0");
    const isStale = freshUntil > 0 && now >= freshUntil;
    if (isStale && !inflightRefreshes.has(canonicalUrl)) {
      inflightRefreshes.add(canonicalUrl);
      const refreshJob = (async () => {
        try {
          const refreshed = await compute(new Request(canonicalUrl, { method: "GET" }));
          if (refreshed.status === 200) {
            await putIntoEdgeCache(cache, cacheKey, refreshed, freshSeconds, Date.now());
          } else {
            await refreshed.body?.cancel().catch(() => {});
          }
        } catch {
          // 后台刷新失败不破坏当前请求，保留既有陈旧副本直至物理过期。
        } finally {
          inflightRefreshes.delete(canonicalUrl);
        }
      })();
      if (ctx) ctx.waitUntil(refreshJob);
      else void refreshJob;
    }

    const headers = new Headers(hit.headers);
    const downstreamCc = headers.get(INTERNAL_DOWNSTREAM_CC);
    if (downstreamCc) headers.set("Cache-Control", downstreamCc);
    headers.delete(INTERNAL_FRESH_UNTIL);
    headers.delete(INTERNAL_DOWNSTREAM_CC);
    headers.set("X-Traffic-Cache", isStale ? "STALE" : "HIT");
    const etag = headers.get("ETag");
    if (etag && ifNoneMatch(request, etag)) {
      await hit.body?.cancel().catch(() => {});
      return notModified(headers);
    }
    if (request.method === "HEAD") {
      await hit.body?.cancel().catch(() => {});
      return new Response(null, { status: hit.status, headers });
    }
    return new Response(hit.body, { status: hit.status, headers });
  }

  const upstream = await compute(new Request(canonicalUrl, { method: "GET" }));
  if (upstream.status !== 200) return upstream;

  const storeClone = upstream.clone();
  const storePromise = putIntoEdgeCache(cache, cacheKey, storeClone, freshSeconds, now);
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

const HOT_CATALOG_PATHS = [
  "/v1/catalog?limit=20",
  "/v1/catalog?limit=20&section=applications",
  "/v1/catalog?limit=20&section=loom",
  "/v1/catalog?limit=20&section=assets",
  "/v1/catalog?limit=20&space=loom",
  "/v1/catalog?limit=20&space=otter",
  "/v1/catalog?limit=20&space=framelab",
];

/** 写操作成功后清理当前边缘机房的热点公开列表与详情缓存，兼顾发布者即时可见与跨机房高命中率。 */
export async function maybePurgePublicEdgeCache(
  request: Request,
  response: Response,
  ctx?: ExecutionContext,
): Promise<void> {
  if (response.status >= 300 || !["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
    return;
  }
  const cache = defaultEdgeCache();
  if (!cache) return;

  const url = new URL(request.url);
  const { origin, pathname } = url;
  const targets: string[] = [];

  const unlistMatch = /^\/v1\/publications\/([0-9a-f-]{36})\/unlist$/.exec(pathname);
  if (unlistMatch) {
    const pubId = unlistMatch[1];
    targets.push(...HOT_CATALOG_PATHS, `/v1/catalog/${pubId}`, `/v1/catalog/${pubId}/cover`);
  } else if (
    /^\/v1\/versions\/[0-9a-f-]{36}\/publish$/.test(pathname) ||
    (/^\/v1\/resources\/[0-9a-f-]{36}(?:\/|$)/.test(pathname) && !pathname.endsWith("/uploads"))
  ) {
    targets.push(...HOT_CATALOG_PATHS);
  } else if (pathname === "/v1/asset-requests" || pathname.startsWith("/v1/asset-requests/")) {
    targets.push("/v1/asset-requests?limit=20");
    const reqMatch = /^\/v1\/asset-requests\/([0-9a-f-]{36})(?:\/|$)/.exec(pathname);
    if (reqMatch) targets.push(`/v1/asset-requests/${reqMatch[1]}`);
  }

  if (!targets.length) return;
  const purgeTask = Promise.all(
    targets.map((target) =>
      cache.delete(new Request(`${origin}${target}`, { method: "GET" })).catch(() => false),
    ),
  ).then(() => {});
  if (ctx) ctx.waitUntil(purgeTask);
  else await purgeTask;
}
