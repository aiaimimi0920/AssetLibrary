import { hasAssetMarketSchema } from "../assets/taxonomy";
import { HttpError, json } from "../http";
import { pageInput, uuid } from "../page";
import {
  isDistributable,
  loadPublication,
  type PublicationRow,
  publicationSelectFor,
  publicationView,
} from "../publications/records";
import type { ScannerRelease } from "../scanner/deployment";
import {
  coverStreamResponse,
  effectiveVersionSpaceSql,
  hasShowcaseSchema,
} from "../spaces/catalog";
import { ifNoneMatch, notModified, publicCacheHeader } from "../traffic/cache";
import { catalogAssetFilters, catalogSection, catalogSpace } from "./catalog-sections";

/** 扫描失效记录也占扫描预算；nextAfter 指向最后扫描项，不漏过后续有效项。 */
export async function listPublications(
  db: D1Database,
  url: URL,
  actor?: string,
  release?: ScannerRelease | null,
) {
  const resourceId = url.searchParams.get("resourceId");
  if (
    resourceId !== null &&
    (!uuid.test(resourceId) || url.searchParams.getAll("resourceId").length !== 1)
  )
    throw new HttpError(400, "INVALID_RESOURCE_ID");
  const [showcase, assetMarket] = await Promise.all([
    hasShowcaseSchema(db),
    hasAssetMarketSchema(db),
  ]);
  const pagination = new URL(url);
  pagination.searchParams.delete("resourceId");
  const section = catalogSection(url, showcase);
  pagination.searchParams.delete("section");
  const space = catalogSpace(url);
  pagination.searchParams.delete("space");
  const assetFilters = catalogAssetFilters(url);
  for (const key of ["category", "style", "format", "license"]) pagination.searchParams.delete(key);
  const kind = url.searchParams.get("kind");
  const query = url.searchParams.get("q");
  if (
    (kind !== null &&
      (!["art", "capability", "mcp", "application"].includes(kind) ||
        url.searchParams.getAll("kind").length !== 1)) ||
    (query !== null &&
      (!query.trim() || query.length > 100 || url.searchParams.getAll("q").length !== 1))
  )
    throw new HttpError(400, "INVALID_CATALOG_FILTER");
  pagination.searchParams.delete("kind");
  pagination.searchParams.delete("q");
  const { after, limit } = pageInput(pagination);
  const hasExplicitAssetFilter =
    assetFilters.category !== null ||
    assetFilters.style !== null ||
    assetFilters.format !== null ||
    assetFilters.license !== null;
  if (!assetMarket && hasExplicitAssetFilter) {
    return json({ items: [], nextAfter: null });
  }
  const library =
    actor === undefined
      ? ""
      : `AND (r.owner = ? OR EXISTS
    (SELECT 1 FROM download_grants g WHERE g.publication_id = p.id AND g.principal = ? AND g.state = 'active'))`;
  const args: (string | number)[] = [after];
  if (resourceId !== null) args.push(resourceId);
  if (kind !== null) args.push(kind);
  if (space !== null) args.push(space);
  if (assetFilters.category !== null) args.push(assetFilters.category);
  if (assetFilters.style !== null) args.push(assetFilters.style);
  if (assetFilters.format !== null) args.push(assetFilters.format);
  if (assetFilters.license !== null) args.push(assetFilters.license);
  if (query !== null) args.push(query.trim());
  if (actor !== undefined) args.push(actor, actor);
  args.push(limit + 1);
  const result = await db
    .prepare(`${publicationSelectFor(showcase, assetMarket)} WHERE p.state = 'published' AND p.id > ?
    ${resourceId === null ? "" : "AND versions.resource_id = ?"}
    ${kind === null ? "" : "AND versions.kind = ?"}
    ${section}
    ${space === null ? "" : `AND ${effectiveVersionSpaceSql(showcase, "vp", "versions")} = ?`}
    ${assetFilters.category === null ? "" : "AND COALESCE(va.category, 'general') = ?"}
    ${assetFilters.style === null ? "" : "AND COALESCE(va.style, 'general') = ?"}
    ${assetFilters.format === null ? "" : "AND EXISTS (SELECT 1 FROM json_each(COALESCE(va.formats, '[]')) WHERE value = ?)"}
    ${assetFilters.license === null ? "" : "AND COALESCE(va.license, 'unspecified') = ?"}
    ${query === null ? "" : "AND instr(lower(versions.title), lower(?)) > 0"}
    ${library} ORDER BY p.id LIMIT ?`)
    .bind(...args)
    .all<PublicationRow>();
  const scanned = result.results.slice(0, limit);
  return json({
    items: scanned.filter((row) => isDistributable(row, release)).map(publicationView),
    nextAfter: result.results.length > limit ? (scanned.at(-1)?.id ?? null) : null,
  });
}

export async function publicDetail(db: D1Database, id: string, release?: ScannerRelease | null) {
  const row = await loadPublication(db, id);
  if (!isDistributable(row, release)) throw new HttpError(404, "NOT_FOUND");
  return json(publicationView(row));
}

export async function publicCover(
  db: D1Database,
  bucket: R2Bucket,
  id: string,
  headOnly: boolean,
  release?: ScannerRelease | null,
  request?: Request,
) {
  const row = await loadPublication(db, id);
  if (
    !isDistributable(row, release) ||
    !row.cover_key ||
    !row.cover_sha256 ||
    row.cover_size === null
  )
    throw new HttpError(404, "NOT_FOUND");
  const cacheControl = publicCacheHeader(60, 300, 60);
  const etag = `"${row.cover_sha256}"`;
  // 协商缓存命中时直接返回 304，不触发 R2 Class B head/get 读取。
  if (request && ifNoneMatch(request, etag)) {
    return notModified({
      ETag: etag,
      "Cache-Control": cacheControl,
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    });
  }
  return coverStreamResponse(
    bucket,
    row.cover_key,
    row.cover_sha256,
    row.cover_size,
    headOnly,
    cacheControl,
  );
}
