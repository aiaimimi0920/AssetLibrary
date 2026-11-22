import { HttpError, json } from "../http";
import { pageInput } from "../page";
import { parseSpace } from "../spaces/catalog";
import {
  type AssetFormat,
  assetFormats,
  decodeFormats,
  hasAssetMarketSchema,
  parseAssetStyle,
  parseRequestCategory,
  parseRequestLicense,
} from "./taxonomy";

export interface AssetRequestRow {
  id: string;
  requester: string;
  title: string;
  category: string;
  style: string;
  space: string;
  formats: string;
  license: string;
  period_days: number;
  budget_note: string;
  description: string;
  delivery: string;
  state: "open" | "closed";
  revision: number;
  response_count: number;
  created_at: number;
  updated_at: number;
}

export interface AssetResponseRow {
  id: string;
  request_id: string;
  responder: string;
  publication_id: string | null;
  publication_title: string | null;
  message: string;
  created_at: number;
}

/** 公开视图不暴露原始 PrincipalRef 或他人私密方案正文。 */
export function publicRequestView(row: AssetRequestRow) {
  return {
    id: row.id,
    title: row.title,
    category: row.category,
    style: row.style,
    space: row.space,
    formats: decodeFormats(row.formats),
    license: row.license,
    periodDays: row.period_days,
    budgetNote: row.budget_note,
    description: row.description,
    delivery: row.delivery,
    state: row.state,
    responseCount: row.response_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function ownerRequestView(row: AssetRequestRow) {
  return {
    ...publicRequestView(row),
    requester: row.requester,
    revision: row.revision,
  };
}

export function responseView(row: AssetResponseRow) {
  return {
    id: row.id,
    requestId: row.request_id,
    responder: row.responder,
    publicationId: row.publication_id,
    publicationTitle: row.publication_title,
    message: row.message,
    createdAt: row.created_at,
  };
}

function singleFilter(url: URL, name: string) {
  const values = url.searchParams.getAll(name);
  if (values.length > 1) throw new HttpError(400, "INVALID_REQUEST_FILTER");
  return values[0] ?? null;
}

function parseListFilters(url: URL) {
  const pagination = new URL(url);
  const category = singleFilter(url, "category");
  const style = singleFilter(url, "style");
  const format = singleFilter(url, "format");
  const license = singleFilter(url, "license");
  const space = singleFilter(url, "space");
  const query = singleFilter(url, "q");
  try {
    if (category !== null) parseRequestCategory(category);
    if (style !== null) parseAssetStyle(style);
    if (license !== null) parseRequestLicense(license);
    if (space !== null) parseSpace(space);
  } catch {
    throw new HttpError(400, "INVALID_REQUEST_FILTER");
  }
  if (format !== null && !assetFormats.includes(format as AssetFormat))
    throw new HttpError(400, "INVALID_REQUEST_FILTER");
  if (query !== null && (!query.trim() || query.length > 100))
    throw new HttpError(400, "INVALID_REQUEST_FILTER");
  for (const key of ["category", "style", "format", "license", "space", "q"])
    pagination.searchParams.delete(key);
  const { after, limit } = pageInput(pagination);
  return { category, style, format, license, space, query: query?.trim() ?? null, after, limit };
}

export async function listAssetRequests(db: D1Database, url: URL, requester?: string) {
  const filters = parseListFilters(url);
  if (!(await hasAssetMarketSchema(db))) return json({ items: [], nextAfter: null });
  const clauses = [requester === undefined ? "r.state = 'open'" : "r.requester = ?", "r.id > ?"];
  const args: (string | number)[] =
    requester === undefined ? [filters.after] : [requester, filters.after];
  if (filters.category !== null) {
    clauses.push("r.category = ?");
    args.push(filters.category);
  }
  if (filters.style !== null) {
    clauses.push("r.style = ?");
    args.push(filters.style);
  }
  if (filters.license !== null) {
    clauses.push("r.license = ?");
    args.push(filters.license);
  }
  if (filters.space !== null) {
    clauses.push("r.space = ?");
    args.push(filters.space);
  }
  if (filters.format !== null) {
    clauses.push("EXISTS (SELECT 1 FROM json_each(r.formats) WHERE value = ?)");
    args.push(filters.format);
  }
  if (filters.query !== null) {
    clauses.push(
      "(instr(lower(r.title), lower(?)) > 0 OR instr(lower(r.description), lower(?)) > 0)",
    );
    args.push(filters.query, filters.query);
  }
  args.push(filters.limit + 1);
  const rows = await db
    .prepare(
      `SELECT r.* FROM asset_requests r WHERE ${clauses.join(" AND ")} ORDER BY r.id LIMIT ?`,
    )
    .bind(...args)
    .all<AssetRequestRow>();
  const page = rows.results.slice(0, filters.limit);
  const mapper = requester === undefined ? publicRequestView : ownerRequestView;
  return json({
    items: page.map(mapper),
    nextAfter: rows.results.length > filters.limit ? (page.at(-1)?.id ?? null) : null,
  });
}

export async function getPublicAssetRequest(db: D1Database, id: string) {
  if (!(await hasAssetMarketSchema(db))) throw new HttpError(404, "NOT_FOUND");
  const row = await db
    .prepare("SELECT * FROM asset_requests WHERE id = ? AND state = 'open'")
    .bind(id)
    .first<AssetRequestRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return json(publicRequestView(row));
}

export async function listRequestResponses(
  db: D1Database,
  requestId: string,
  principal: string,
  url: URL,
) {
  const { after, limit } = pageInput(url);
  if (!(await hasAssetMarketSchema(db))) throw new HttpError(404, "NOT_FOUND");
  const requestRow = await db
    .prepare("SELECT * FROM asset_requests WHERE id = ?")
    .bind(requestId)
    .first<AssetRequestRow>();
  if (!requestRow || (requestRow.state !== "open" && requestRow.requester !== principal))
    throw new HttpError(404, "NOT_FOUND");
  const isRequester = requestRow.requester === principal;
  const rows = await db
    .prepare(
      `SELECT resp.*, v.title AS publication_title
       FROM asset_request_responses resp
       LEFT JOIN publications p ON p.id = resp.publication_id AND p.state = 'published'
       LEFT JOIN versions v ON v.id = p.version_id
       WHERE resp.request_id = ? AND resp.id > ?
       ${isRequester ? "" : "AND resp.responder = ?"}
       ORDER BY resp.id LIMIT ?`,
    )
    .bind(
      ...(isRequester ? [requestId, after, limit + 1] : [requestId, after, principal, limit + 1]),
    )
    .all<AssetResponseRow>();
  const page = rows.results.slice(0, limit);
  return json({
    viewerRole: isRequester ? "requester" : "responder",
    request: isRequester ? ownerRequestView(requestRow) : publicRequestView(requestRow),
    items: page.map(responseView),
    nextAfter: rows.results.length > limit ? (page.at(-1)?.id ?? null) : null,
  });
}
