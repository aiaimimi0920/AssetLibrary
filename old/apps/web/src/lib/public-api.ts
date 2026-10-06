import { parsePackagePage, parsePublishedPackage, type PackageKind, type PackagePage, type PublishedPackage } from "./contracts";
import {
  parsePublishedReleasePage,
  parsePublisherProfile,
  type PublishedReleasePage,
  type PublisherProfile,
} from "./public-details";

const DEFAULT_API_URL = "http://127.0.0.1:8080";
const REQUEST_TIMEOUT_MS = 5_000;

export type PublicApiFailure = "invalid_request" | "not_found" | "unavailable" | "invalid_response";

export type PublicApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: PublicApiFailure };

interface CatalogQuery {
  kind?: PackageKind;
  publisher?: string;
  cursor?: string;
  limit?: number;
}

interface SearchQuery extends CatalogQuery {
  q: string;
  tag?: string;
}

function validCursor(value: string, maximum: number): boolean {
  return value.length > 0 && value.length <= maximum && /^[A-Za-z0-9_-]+$/.test(value);
}

function safeQueryText(value: string, maximum: number): boolean {
  return value.length <= maximum && !/[\u0000-\u001f\u007f]/.test(value);
}

function isCatalogQueryValid(query: CatalogQuery, cursorMaximum = 256): boolean {
  return (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100)
    && (query.cursor === undefined || validCursor(query.cursor, cursorMaximum))
    && (query.publisher === undefined || validSlug(query.publisher));
}

function validSlug(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,119}$/.test(value);
}

function apiBaseUrl(): URL {
  const configured = process.env.ASSETLIBRARY_API_URL
    ?? process.env.NEXT_PUBLIC_ASSETLIBRARY_API_URL
    ?? DEFAULT_API_URL;
  const url = new URL(configured);
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error("AssetLibrary API URL must use HTTP or HTTPS");
  }
  return url;
}

export function publicApiEndpoint(path: string, query?: object): URL {
  const url = new URL(path, apiBaseUrl());
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function request<T>(
  path: string,
  query: object | undefined,
  parser: (value: unknown) => T,
  cache: RequestCache,
): Promise<PublicApiResult<T>> {
  try {
    const url = publicApiEndpoint(path, query);
    const response = await fetch(url, {
      cache,
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 400) return { ok: false, failure: "invalid_request" };
    if (response.status === 404) return { ok: false, failure: "not_found" };
    if (!response.ok) return { ok: false, failure: "unavailable" };
    try {
      return { ok: true, data: parser(await response.json()) };
    } catch {
      return { ok: false, failure: "invalid_response" };
    }
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export function listPackages(query: CatalogQuery = {}): Promise<PublicApiResult<PackagePage>> {
  if (!isCatalogQueryValid(query)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(
    "/v1/public/packages",
    query,
    parsePackagePage,
    "no-store",
  );
}

export function searchPackages(query: SearchQuery): Promise<PublicApiResult<PackagePage>> {
  if (
    !isCatalogQueryValid(query, 1024)
    || !safeQueryText(query.q, 200)
    || query.q.trim().length < 1
    || query.tag !== undefined && (!safeQueryText(query.tag, 100) || query.tag.trim() !== query.tag || query.tag.length < 1)
  ) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(
    "/v1/public/search",
    query,
    parsePackagePage,
    "no-store",
  );
}

export function getPackage(slug: string): Promise<PublicApiResult<PublishedPackage>> {
  if (!validSlug(slug)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(
    `/v1/public/packages/${encodeURIComponent(slug)}`,
    undefined,
    parsePublishedPackage,
    "no-store",
  );
}

export function getPublisher(slug: string): Promise<PublicApiResult<PublisherProfile>> {
  if (!validSlug(slug)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(
    `/v1/public/publishers/${encodeURIComponent(slug)}`,
    undefined,
    parsePublisherProfile,
    "no-store",
  );
}

export function listPackageReleases(
  slug: string,
  query: Pick<CatalogQuery, "cursor" | "limit"> = {},
): Promise<PublicApiResult<PublishedReleasePage>> {
  if (!validSlug(slug) || !isCatalogQueryValid(query)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(
    `/v1/public/packages/${encodeURIComponent(slug)}/releases`,
    query,
    parsePublishedReleasePage,
    "no-store",
  );
}
