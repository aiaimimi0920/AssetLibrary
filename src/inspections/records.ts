import { HttpError } from "../http";

export const policy = "art-png-rgba8-v1";
export const packagePolicy = "art-zip-manifest-v1";
export const maxObjectSize = 1024 * 1024;
export const maxArchiveSize = 8 * 1024 * 1024;
export type InspectionState =
  | "queued"
  | "running"
  | "passed"
  | "rejected"
  | "invalidated"
  | "failed";
export interface InspectionRow {
  id: string;
  upload_id: string;
  policy: string;
  upload_revision: number;
  expected_size: number;
  sha256: string;
  etag: string;
  state: InspectionState;
  revision: number;
  attempts: number;
  lease_token: string | null;
  lease_until: number;
  next_attempt_at: number;
  error: string | null;
  result: string | null;
  owner: string;
  resource_id: string;
  resource_kind: string;
  resource_state: string;
  upload_state: string;
  current_upload_revision: number;
  current_size: number;
  current_sha256: string;
  current_etag: string | null;
}

// 此谓词在写入事务内使用；不能用早先的 GET 代替最终准入条件。
export const currentBinding = `EXISTS (SELECT 1 FROM uploads u JOIN resources r ON r.id = u.resource_id
  WHERE u.id = inspections.upload_id AND u.state = 'quarantined' AND r.state = 'draft'
  AND r.kind = 'art' AND u.revision = inspections.upload_revision
  AND u.expected_size = inspections.expected_size AND u.sha256 = inspections.sha256
  AND u.etag = inspections.etag)`;

export function bindingCurrent(row: InspectionRow): boolean {
  return (
    row.resource_state === "draft" &&
    row.resource_kind === "art" &&
    row.upload_state === "quarantined" &&
    row.current_upload_revision === row.upload_revision &&
    row.current_size === row.expected_size &&
    row.current_sha256 === row.sha256 &&
    row.current_etag === row.etag
  );
}

export async function findInspection(
  db: D1Database,
  uploadId: string,
): Promise<InspectionRow | null> {
  return db
    .prepare(`SELECT i.*, u.owner, u.resource_id, r.kind AS resource_kind,
    r.state AS resource_state, u.state AS upload_state, u.revision AS current_upload_revision,
    u.expected_size AS current_size, u.sha256 AS current_sha256, u.etag AS current_etag
    FROM inspections i JOIN uploads u ON u.id = i.upload_id
    JOIN resources r ON r.id = u.resource_id WHERE i.upload_id = ?`)
    .bind(uploadId)
    .first<InspectionRow>();
}

export async function loadInspection(db: D1Database, uploadId: string): Promise<InspectionRow> {
  const row = await findInspection(db, uploadId);
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return row;
}

export function inspectionView(row: InspectionRow) {
  return {
    id: row.id,
    uploadId: row.upload_id,
    policy: row.policy,
    state: row.state,
    revision: row.revision,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    bindingCurrent: bindingCurrent(row),
    error: row.error,
    result: row.result === null ? null : JSON.parse(row.result),
    checkedIdentity: {
      uploadRevision: row.upload_revision,
      size: row.expected_size,
      sha256: row.sha256,
      etag: row.etag,
    },
    publicationEligible: false,
  };
}

export function inspectionEvent(
  db: D1Database,
  operation: string,
  id: string,
  actor: string,
  now: number,
) {
  return db
    .prepare(`INSERT INTO inspection_events(operation_id, inspection_id, actor, state, revision, created_at)
    SELECT ?, id, ?, state, revision, ? FROM inspections WHERE id = ? AND last_operation = ?`)
    .bind(operation, actor, now, id, operation);
}
