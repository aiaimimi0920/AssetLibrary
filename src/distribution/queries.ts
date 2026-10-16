import { HttpError, json } from "../http";
import { pageInput } from "../page";
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
  release?: ScannerRelease,
) {
  const { after, limit } = pageInput(url);
  const library =
    actor === undefined
      ? ""
      : `AND (r.owner = ? OR EXISTS
    (SELECT 1 FROM download_grants g WHERE g.publication_id = p.id AND g.principal = ? AND g.state = 'active'))`;
  const args = actor === undefined ? [after, limit + 1] : [after, actor, actor, limit + 1];
  const result = await db
    .prepare(`${publicationSelect} WHERE p.state = 'published' AND p.id > ?
    ${library} ORDER BY p.id LIMIT ?`)
    .bind(...args)
    .all<PublicationRow>();
  const scanned = result.results.slice(0, limit);
  return json({
    items: scanned.filter((row) => isDistributable(row, release)).map(publicationView),
    nextAfter: result.results.length > limit ? (scanned.at(-1)?.id ?? null) : null,
  });
}

export async function publicDetail(db: D1Database, id: string, release?: ScannerRelease) {
  const row = await loadPublication(db, id);
  if (!isDistributable(row, release)) throw new HttpError(404, "NOT_FOUND");
  return json(publicationView(row));
}
