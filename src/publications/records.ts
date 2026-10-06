import { HttpError } from "../http";
import { scanPoliciesSql } from "../inspections/policy";
import { parseScanFact, scanCurrent } from "../scanner/facts";
import { currentSnapshot } from "../versions/records";

export interface PublicationRow {
  id: string;
  version_id: string;
  version_revision: number;
  scan_result: string;
  state: "published" | "unlisted";
  revision: number;
  created_at: number;
  updated_at: number;
  last_operation: string;
  owner: string;
  resource_id: string;
  label: string;
  title: string;
  kind: string;
  inspection_policy: string;
  upload_id: string;
  expected_size: number;
  sha256: string;
  etag: string;
  binding_current: number;
}

// 所有分发查询复用当前绑定，不用缓存/副本或历史发布状态替代撤销检查。
export const publicationSelect = `SELECT p.*, r.owner, versions.resource_id,
  versions.label, versions.title, versions.kind, versions.upload_id,
  versions.expected_size, versions.sha256, versions.etag, versions.inspection_policy,
  CASE WHEN versions.state = 'approved' AND versions.revision = p.version_revision
    AND versions.inspection_policy IN (${scanPoliciesSql})
    AND checked.result = p.scan_result AND ${currentSnapshot} THEN 1 ELSE 0 END AS binding_current
  FROM publications p JOIN versions ON versions.id = p.version_id
  JOIN resources r ON r.id = versions.resource_id
  JOIN inspections checked ON checked.id = versions.inspection_id`;

export async function loadPublication(db: D1Database, id: string) {
  const row = await db
    .prepare(`${publicationSelect} WHERE p.id = ?`)
    .bind(id)
    .first<PublicationRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return row;
}

export function publicationScan(row: PublicationRow) {
  try {
    const scan = parseScanFact(JSON.parse(row.scan_result).scan, row.sha256, row.expected_size);
    return scan.verdict === "clean" && scanCurrent(scan) ? scan : null;
  } catch {
    return null;
  }
}

export function isDistributable(row: PublicationRow) {
  return row.state === "published" && row.binding_current === 1 && publicationScan(row) !== null;
}

export function publicationView(row: PublicationRow) {
  return {
    id: row.id,
    resourceId: row.resource_id,
    versionId: row.version_id,
    label: row.label,
    title: row.title,
    kind: row.kind,
    size: row.expected_size,
    sha256: row.sha256,
    state: row.state,
    revision: row.revision,
    bindingCurrent: row.binding_current === 1,
    scanCurrent: publicationScan(row) !== null,
    policy: row.inspection_policy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
