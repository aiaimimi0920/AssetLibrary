import { HttpError } from "../http";
import { policyKindSql } from "../inspections/policy";
import { versionSafety } from "./safety";

export interface VersionRow {
  id: string;
  resource_id: string;
  label: string;
  resource_revision: number;
  title: string;
  kind: string;
  upload_id: string;
  upload_revision: number;
  expected_size: number;
  sha256: string;
  etag: string;
  inspection_id: string;
  inspection_revision: number;
  inspection_policy: string;
  inspection_result: string | null;
  state: "pending_review" | "approved" | "rejected" | "withdrawn";
  revision: number;
  reviewer: string | null;
  review_decision: string | null;
  review_reason: string | null;
  reviewed_at: number | null;
  created_at: number;
  updated_at: number;
  last_operation: string;
  owner: string;
  binding_current: number;
  publication_id: string | null;
  publication_state: string | null;
  publication_revision: number | null;
}

// 批准事务和查询共用完整快照条件；历史 passed 不能替代当前资源/上传身份。
export const currentSnapshot = `EXISTS (SELECT 1 FROM resources r
  JOIN uploads u ON u.resource_id = r.id JOIN inspections i ON i.upload_id = u.id
  WHERE r.id = versions.resource_id AND r.state = 'draft' AND r.kind = versions.kind
  AND r.revision = versions.resource_revision AND r.title = versions.title AND u.owner = r.owner
  AND u.id = versions.upload_id AND u.state = 'quarantined' AND u.revision = versions.upload_revision
  AND u.expected_size = versions.expected_size AND u.sha256 = versions.sha256 AND u.etag = versions.etag
  AND i.id = versions.inspection_id AND i.state = 'passed' AND i.revision = versions.inspection_revision
  AND i.policy = versions.inspection_policy AND i.upload_revision = u.revision
  AND r.kind = ${policyKindSql("i.policy")}
  AND i.expected_size = u.expected_size AND i.sha256 = u.sha256 AND i.etag = u.etag
  AND json_extract(i.result, '$.sha256') = u.sha256)`;

export const versionSelect = `SELECT versions.*, r.owner, checked.result AS inspection_result,
  p.id AS publication_id, p.state AS publication_state, p.revision AS publication_revision,
  CASE WHEN ${currentSnapshot} THEN 1 ELSE 0 END AS binding_current
  FROM versions JOIN resources r ON r.id = versions.resource_id
  JOIN inspections checked ON checked.id = versions.inspection_id
  LEFT JOIN publications p ON p.version_id = versions.id`;

export async function loadVersion(db: D1Database, id: string): Promise<VersionRow> {
  const row = await db
    .prepare(`${versionSelect} WHERE versions.id = ?`)
    .bind(id)
    .first<VersionRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return row;
}

export function versionView(row: VersionRow) {
  const safety = versionSafety(row);
  return {
    id: row.id,
    resourceId: row.resource_id,
    label: row.label,
    state: row.state,
    revision: row.revision,
    snapshot: {
      resourceRevision: row.resource_revision,
      title: row.title,
      kind: row.kind,
      uploadId: row.upload_id,
      uploadRevision: row.upload_revision,
      size: row.expected_size,
      sha256: row.sha256,
      etag: row.etag,
      inspection: {
        id: row.inspection_id,
        revision: row.inspection_revision,
        policy: row.inspection_policy,
      },
    },
    review:
      row.reviewer === null
        ? null
        : {
            reviewer: row.reviewer,
            decision: row.review_decision,
            reason: row.review_reason,
            at: row.reviewed_at,
          },
    bindingCurrent: row.binding_current === 1,
    publication:
      row.publication_id === null
        ? null
        : {
            id: row.publication_id,
            state: row.publication_state,
            revision: row.publication_revision,
          },
    publicationEligible: false,
    contentSafety: { scan: safety.scan, scanCurrent: safety.scanCurrent, cloudValidated: false },
    publicationBlockers: [
      ...(row.state === "approved" ? [] : ["VERSION_NOT_APPROVED"]),
      ...(row.binding_current === 1 ? [] : ["VERSION_BINDING_CHANGED"]),
      safety.blocker,
    ],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function versionEvent(
  db: D1Database,
  id: string,
  operation: string,
  actor: string,
  action: string,
  reason: string | null,
  now: number,
) {
  return db
    .prepare(`INSERT INTO version_events(operation_id, version_id, actor, action, revision, reason, created_at)
    SELECT ?, id, ?, ?, revision, ?, ? FROM versions WHERE id = ? AND last_operation = ?`)
    .bind(operation, actor, action, reason, now, id, operation);
}
