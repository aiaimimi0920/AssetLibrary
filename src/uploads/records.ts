import { HttpError } from "../http";

export interface UploadEnv {
  DB: D1Database;
  QUARANTINE: R2Bucket;
  SCANNER?: Fetcher;
}
export type UploadState =
  | "pending"
  | "quarantined"
  | "cancelled"
  | "expired"
  | "missing"
  | "rejected";
export interface UploadRow {
  id: string;
  resource_id: string;
  owner: string;
  expected_size: number;
  sha256: string;
  state: UploadState;
  revision: number;
  etag: string | null;
  expires_at: number;
  reconcile_at: number;
  created_at: number;
  updated_at: number;
  resource_state: string;
  resource_kind: string;
}

export const uploadJson = `json_object('id', id, 'resourceId', resource_id,
  'state', state, 'revision', revision, 'size', expected_size, 'sha256', sha256,
  'expiresAt', expires_at, 'contentUrl', '/v1/uploads/' || id || '/content')`;

export function uploadView(row: UploadRow) {
  return {
    id: row.id,
    resourceId: row.resource_id,
    state: row.state,
    revision: row.revision,
    size: row.expected_size,
    sha256: row.sha256,
    expiresAt: row.expires_at,
    contentUrl: `/v1/uploads/${row.id}/content`,
  };
}

export function objectKey(row: Pick<UploadRow, "resource_id" | "id">): string {
  return `quarantine/${row.resource_id}/${row.id}`;
}

export function isTerminal(row: UploadRow): boolean {
  return row.state !== "pending" && row.state !== "quarantined";
}

export async function loadUpload(db: D1Database, id: string): Promise<UploadRow> {
  const row = await db
    .prepare(`SELECT u.*, r.state AS resource_state, r.kind AS resource_kind FROM uploads u
    JOIN resources r ON r.id = u.resource_id WHERE u.id = ?`)
    .bind(id)
    .first<UploadRow>();
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return row;
}

export async function loadOwned(db: D1Database, id: string, principal: string): Promise<UploadRow> {
  const row = await loadUpload(db, id);
  // 成员的目录读授权不能升级为包体上传或隔离对象管理权。
  if (row.owner !== principal) throw new HttpError(404, "NOT_FOUND");
  return row;
}

/** 状态、审计同批 CAS；完成还要在事务内重新检查资源和过期时间。 */
export async function transition(
  env: UploadEnv,
  row: UploadRow,
  state: UploadState,
  actor: string,
  etag: string | null = null,
) {
  const operation = crypto.randomUUID();
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE uploads SET state = ?, etag = ?, revision = revision + 1,
      updated_at = ?, reconcile_at = ?, last_operation = ?
      WHERE id = ? AND revision = ? AND state = ? AND state <> ?
      AND (? <> 'quarantined' OR (expires_at > ? AND EXISTS (
        SELECT 1 FROM resources WHERE id = uploads.resource_id AND state = 'draft')))`).bind(
      state,
      etag,
      now,
      now,
      operation,
      row.id,
      row.revision,
      row.state,
      state,
      state,
      now,
    ),
    env.DB.prepare(`INSERT INTO upload_events(operation_id, upload_id, actor, state, revision, created_at)
      SELECT ?, id, ?, state, revision, ? FROM uploads WHERE id = ? AND last_operation = ?`).bind(
      operation,
      actor,
      now,
      row.id,
      operation,
    ),
  ]);
  return loadUpload(env.DB, row.id);
}

export async function scheduleCheck(db: D1Database, row: UploadRow, at: number) {
  // 不让较早的异步对账覆盖新状态留下的立即清理时间。
  await db
    .prepare("UPDATE uploads SET reconcile_at = ? WHERE id = ? AND revision = ?")
    .bind(at, row.id, row.revision)
    .run();
}
