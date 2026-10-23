import { HttpError, json } from "../http";
import { pageInput, uuid } from "../page";
import {
  isDistributable,
  loadPublication,
  type PublicationRow,
  publicationSelect,
  publicationView,
} from "../publications/records";
import type { ScannerRelease } from "../scanner/deployment";

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
  const pagination = new URL(url);
  pagination.searchParams.delete("resourceId");
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
  const library =
    actor === undefined
      ? ""
      : `AND (r.owner = ? OR EXISTS
    (SELECT 1 FROM download_grants g WHERE g.publication_id = p.id AND g.principal = ? AND g.state = 'active'))`;
  const args: (string | number)[] = [after];
  if (resourceId !== null) args.push(resourceId);
  if (kind !== null) args.push(kind);
  if (query !== null) args.push(query.trim());
  if (actor !== undefined) args.push(actor, actor);
  args.push(limit + 1);
  const result = await db
    .prepare(`${publicationSelect} WHERE p.state = 'published' AND p.id > ?
    ${resourceId === null ? "" : "AND versions.resource_id = ?"}
    ${kind === null ? "" : "AND versions.kind = ?"}
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
