import { HttpError, json } from "../http";
import { policyKindSql } from "../inspections/policy";
import { type VersionRow, versionEvent, versionSelect, versionView } from "./records";

export interface NewVersion {
  resourceId: string;
  resourceRevision: number;
  uploadId: string;
  label: string;
}

/** 标签是创建的自然幂等身份；不同输入不得占用或重写已有版本。 */
export async function createVersion(db: D1Database, actor: string, input: NewVersion) {
  const resource = await db
    .prepare(`SELECT kind FROM resources
    WHERE id = ? AND owner = ? AND state = 'draft'`)
    .bind(input.resourceId, actor)
    .first<{ kind: string }>();
  if (!resource) throw new HttpError(404, "NOT_FOUND");
  if (!["art", "capability", "application"].includes(resource.kind))
    throw new HttpError(422, "VERSION_POLICY_UNAVAILABLE");
  const upload = await db
    .prepare(`SELECT id FROM uploads WHERE id = ? AND resource_id = ? AND owner = ?`)
    .bind(input.uploadId, input.resourceId, actor)
    .first();
  if (!upload) throw new HttpError(404, "NOT_FOUND");
  const id = crypto.randomUUID();
  const operation = crypto.randomUUID();
  const now = Date.now();
  const results = await db.batch<VersionRow>([
    db
      .prepare(`INSERT INTO versions(id, resource_id, label, resource_revision, title, kind,
      upload_id, upload_revision, expected_size, sha256, etag, inspection_id, inspection_revision,
      inspection_policy, state, revision, created_at, updated_at, last_operation)
      SELECT ?, r.id, ?, r.revision, r.title, r.kind, u.id, u.revision, u.expected_size, u.sha256,
      u.etag, i.id, i.revision, i.policy, 'pending_review', 1, ?, ?, ?
      FROM resources r JOIN uploads u ON u.resource_id = r.id JOIN inspections i ON i.upload_id = u.id
      WHERE r.id = ? AND r.owner = ? AND r.state = 'draft' AND r.revision = ?
      AND u.id = ? AND u.owner = r.owner AND u.state = 'quarantined' AND i.state = 'passed'
      AND r.kind = ${policyKindSql("i.policy")} AND i.upload_revision = u.revision AND i.expected_size = u.expected_size
      AND i.sha256 = u.sha256 AND i.etag = u.etag AND json_extract(i.result, '$.sha256') = u.sha256
      ON CONFLICT(resource_id, label) DO NOTHING`)
      .bind(
        id,
        input.label,
        now,
        now,
        operation,
        input.resourceId,
        actor,
        input.resourceRevision,
        input.uploadId,
      ),
    versionEvent(db, id, operation, actor, "created", null, now),
    db
      .prepare(
        `${versionSelect} WHERE versions.resource_id = ? AND versions.label = ? AND r.owner = ?`,
      )
      .bind(input.resourceId, input.label, actor),
  ]);
  const row = results.at(-1)?.results[0];
  if (!row) throw new HttpError(409, "VERSION_BINDING_NOT_READY");
  if (row.upload_id !== input.uploadId || row.resource_revision !== input.resourceRevision)
    throw new HttpError(409, "VERSION_LABEL_CONFLICT");
  return json(versionView(row), row.last_operation === operation ? 201 : 200);
}
