import { exactFields, HttpError, json, readJson } from "../http";
import { loadOwned, type UploadEnv } from "../uploads/records";
import { inspectionKind } from "./policy";
import {
  findInspection,
  inspectionEvent,
  inspectionView,
  loadInspection,
  maxArchiveSize,
  maxObjectSize,
  policy,
} from "./records";

const pathPattern =
  /^\/v1\/uploads\/([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\/inspection$/;

export async function inspectionRoutes(
  request: Request,
  env: UploadEnv,
  principal: string,
): Promise<Response | null> {
  const match = pathPattern.exec(new URL(request.url).pathname);
  if (!match) return null;
  const upload = await loadOwned(env.DB, match[1] ?? "", principal);
  if (request.method === "GET")
    return json(inspectionView(await loadInspection(env.DB, upload.id)));
  if (request.method !== "POST") throw new HttpError(404, "NOT_FOUND");
  const body = await readJson(request);
  exactFields(body, ["policy"]);
  const requestedPolicy = body.policy === undefined ? policy : body.policy;
  const kind = inspectionKind(requestedPolicy);
  if (!kind) throw new HttpError(422, "INSPECTION_POLICY_UNAVAILABLE");
  if (upload.state !== "quarantined" || upload.resource_state !== "draft")
    throw new HttpError(409, "INSPECTION_NOT_ELIGIBLE");
  if (upload.resource_kind !== kind) throw new HttpError(422, "INSPECTION_POLICY_UNAVAILABLE");
  const limit = requestedPolicy === policy ? maxObjectSize : maxArchiveSize;
  if (upload.expected_size > limit) {
    const prior = await findInspection(env.DB, upload.id);
    if (prior && prior.policy !== requestedPolicy)
      throw new HttpError(409, "INSPECTION_POLICY_CONFLICT");
    throw new HttpError(422, "INSPECTION_SIZE_UNSUPPORTED");
  }
  const id = crypto.randomUUID();
  const operation = crypto.randomUUID();
  const now = Date.now();
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO inspections(id, upload_id, policy, upload_revision, expected_size,
      sha256, etag, state, revision, attempts, lease_until, next_attempt_at, created_at, updated_at, last_operation)
      SELECT ?, u.id, ?, u.revision, u.expected_size, u.sha256, u.etag, 'queued', 1, 0, 0, ?, ?, ?, ?
      FROM uploads u JOIN resources r ON r.id = u.resource_id WHERE u.id = ? AND u.owner = ?
      AND u.state = 'quarantined' AND u.etag IS NOT NULL AND r.state = 'draft' AND r.kind = ?
      AND u.expected_size <= ? ON CONFLICT(upload_id) DO NOTHING`).bind(
      id,
      requestedPolicy,
      now,
      now,
      now,
      operation,
      upload.id,
      principal,
      kind,
      limit,
    ),
    inspectionEvent(env.DB, operation, id, principal, now),
  ]);
  const row = await findInspection(env.DB, upload.id);
  if (!row) throw new HttpError(409, "INSPECTION_NOT_ELIGIBLE");
  if (row.policy !== requestedPolicy) throw new HttpError(409, "INSPECTION_POLICY_CONFLICT");
  return json(inspectionView(row), results[0]?.meta.changes ? 201 : 200);
}
