import { HttpError, json } from "../http";
import type { ResourceSpace } from "../spaces/catalog";
import {
  type AssetFormat,
  type AssetStyle,
  hasAssetMarketSchema,
  type RequestCategory,
  type RequestLicense,
} from "./taxonomy";

export interface CreateAssetRequestInput {
  title: string;
  category: RequestCategory;
  style: AssetStyle;
  space: ResourceSpace;
  formats: AssetFormat[];
  license: RequestLicense;
  periodDays: number;
  budgetNote: string;
  description: string;
  delivery: string;
}

export interface CreateAssetResponseInput {
  message: string;
  publicationId: string | null;
}

interface Receipt {
  fingerprint: string;
  status: number;
  response: string;
}

const ownerRequestSql = `json_object(
  'id', r.id,
  'requester', r.requester,
  'title', r.title,
  'category', r.category,
  'style', r.style,
  'space', r.space,
  'formats', json(r.formats),
  'license', r.license,
  'periodDays', r.period_days,
  'budgetNote', r.budget_note,
  'description', r.description,
  'delivery', r.delivery,
  'state', r.state,
  'revision', r.revision,
  'responseCount', r.response_count,
  'createdAt', r.created_at,
  'updatedAt', r.updated_at
)`;

function validateIdempotencyKey(key: string) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY");
}

async function hashFingerprint(payload: unknown): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 幂等记录、业务状态与审计在同一 D1 batch 事务内完成，不分散二次更新。 */
export async function createAssetRequest(
  db: D1Database,
  principal: string,
  key: string,
  input: CreateAssetRequestInput,
) {
  validateIdempotencyKey(key);
  if (!(await hasAssetMarketSchema(db))) throw new HttpError(503, "SERVICE_UNAVAILABLE");
  const fingerprint = await hashFingerprint({ scope: "asset_request:create", ...input });
  const operation = crypto.randomUUID();
  const id = crypto.randomUUID();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const formatsJson = JSON.stringify(input.formats);
  const gate = "EXISTS (SELECT 1 FROM mutation_requests WHERE operation_id = ? AND status = 201)";

  const results = await db.batch<Receipt>([
    db
      .prepare(
        `INSERT INTO mutation_requests
          (principal, request_key, fingerprint, operation_id, status, created_at)
         VALUES (?, ?, ?, ?, 201, ?) ON CONFLICT(principal, request_key) DO NOTHING`,
      )
      .bind(principal, key, fingerprint, operation, nowIso),
    db
      .prepare(
        `INSERT INTO asset_requests
          (id, requester, title, category, style, space, formats, license,
           period_days, budget_note, description, delivery, state, revision,
           response_count, created_at, updated_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', 1, 0, ?, ? WHERE ${gate}`,
      )
      .bind(
        id,
        principal,
        input.title,
        input.category,
        input.style,
        input.space,
        formatsJson,
        input.license,
        input.periodDays,
        input.budgetNote,
        input.description,
        input.delivery,
        now,
        now,
        operation,
      ),
    db
      .prepare(
        `UPDATE mutation_requests SET response = (
          SELECT ${ownerRequestSql} FROM asset_requests r WHERE r.id = ?
        ) WHERE operation_id = ? AND status = 201`,
      )
      .bind(id, operation),
    db
      .prepare(
        `INSERT INTO asset_request_events
          (operation_id, request_id, actor, action, revision, created_at)
         SELECT ?, id, ?, 'created', revision, ? FROM asset_requests WHERE id = ? AND ${gate}`,
      )
      .bind(operation, principal, now, id, operation),
    db
      .prepare(
        "SELECT fingerprint, status, response FROM mutation_requests WHERE principal = ? AND request_key = ?",
      )
      .bind(principal, key),
  ]);

  const receipt = results.at(-1)?.results[0];
  if (!receipt) throw new Error("MISSING_MUTATION_RECEIPT");
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return json(JSON.parse(receipt.response), receipt.status);
}

export async function closeAssetRequest(
  db: D1Database,
  principal: string,
  key: string,
  id: string,
  expectedRevision: number,
) {
  validateIdempotencyKey(key);
  if (!(await hasAssetMarketSchema(db))) throw new HttpError(503, "SERVICE_UNAVAILABLE");
  const fingerprint = await hashFingerprint({
    scope: "asset_request:close",
    id,
    revision: expectedRevision,
  });
  const operation = crypto.randomUUID();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const gate = "EXISTS (SELECT 1 FROM mutation_requests WHERE operation_id = ? AND status = 200)";

  const results = await db.batch<Receipt>([
    db
      .prepare(
        `INSERT INTO mutation_requests
          (principal, request_key, fingerprint, operation_id, status, response, created_at)
         VALUES (?, ?, ?, ?,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND requester = ?) THEN 404
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND state = 'open' AND revision = ?) THEN 409
             ELSE 200
           END,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND requester = ?) THEN '{"error":"NOT_FOUND"}'
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND state = 'open') THEN '{"error":"REQUEST_CLOSED"}'
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND revision = ?) THEN '{"error":"REVISION_CONFLICT"}'
             ELSE '{}'
           END,
           ?) ON CONFLICT(principal, request_key) DO NOTHING`,
      )
      .bind(
        principal,
        key,
        fingerprint,
        operation,
        id,
        principal,
        id,
        expectedRevision,
        id,
        principal,
        id,
        id,
        expectedRevision,
        nowIso,
      ),
    db
      .prepare(
        `UPDATE asset_requests SET state = 'closed', revision = revision + 1, updated_at = ?
         WHERE id = ? AND ${gate}`,
      )
      .bind(now, id, operation),
    db
      .prepare(
        `UPDATE mutation_requests SET response = (
          SELECT ${ownerRequestSql} FROM asset_requests r WHERE r.id = ?
        ) WHERE operation_id = ? AND status = 200`,
      )
      .bind(id, operation),
    db
      .prepare(
        `INSERT INTO asset_request_events
          (operation_id, request_id, actor, action, revision, created_at)
         SELECT ?, id, ?, 'closed', revision, ? FROM asset_requests WHERE id = ? AND ${gate}`,
      )
      .bind(operation, principal, now, id, operation),
    db
      .prepare(
        "SELECT fingerprint, status, response FROM mutation_requests WHERE principal = ? AND request_key = ?",
      )
      .bind(principal, key),
  ]);

  const receipt = results.at(-1)?.results[0];
  if (!receipt) throw new Error("MISSING_MUTATION_RECEIPT");
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return json(JSON.parse(receipt.response), receipt.status);
}

export async function respondToAssetRequest(
  db: D1Database,
  principal: string,
  key: string,
  requestId: string,
  input: CreateAssetResponseInput,
) {
  validateIdempotencyKey(key);
  if (!(await hasAssetMarketSchema(db))) throw new HttpError(503, "SERVICE_UNAVAILABLE");
  const fingerprint = await hashFingerprint({
    scope: "asset_request:respond",
    requestId,
    ...input,
  });
  const operation = crypto.randomUUID();
  const responseId = crypto.randomUUID();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const gate = "EXISTS (SELECT 1 FROM mutation_requests WHERE operation_id = ? AND status = 201)";
  const pubCheck = `SELECT 1 FROM publications p
    JOIN versions v ON v.id = p.version_id
    JOIN resources r ON r.id = v.resource_id
    WHERE p.id = ? AND r.owner = ? AND p.state = 'published'`;

  const results = await db.batch<Receipt>([
    db
      .prepare(
        `INSERT INTO mutation_requests
          (principal, request_key, fingerprint, operation_id, status, response, created_at)
         VALUES (?, ?, ?, ?,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ?) THEN 404
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND state = 'open') THEN 409
             WHEN EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND requester = ?) THEN 409
             WHEN EXISTS (SELECT 1 FROM asset_request_responses WHERE request_id = ? AND responder = ?) THEN 409
             WHEN ? IS NOT NULL AND NOT EXISTS (${pubCheck}) THEN 409
             ELSE 201
           END,
           CASE
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ?) THEN '{"error":"NOT_FOUND"}'
             WHEN NOT EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND state = 'open') THEN '{"error":"REQUEST_CLOSED"}'
             WHEN EXISTS (SELECT 1 FROM asset_requests WHERE id = ? AND requester = ?) THEN '{"error":"SELF_RESPONSE_FORBIDDEN"}'
             WHEN EXISTS (SELECT 1 FROM asset_request_responses WHERE request_id = ? AND responder = ?) THEN '{"error":"RESPONSE_ALREADY_SUBMITTED"}'
             WHEN ? IS NOT NULL AND NOT EXISTS (${pubCheck}) THEN '{"error":"INVALID_RESPONSE_PUBLICATION"}'
             ELSE '{}'
           END,
           ?) ON CONFLICT(principal, request_key) DO NOTHING`,
      )
      .bind(
        principal,
        key,
        fingerprint,
        operation,
        requestId,
        requestId,
        requestId,
        principal,
        requestId,
        principal,
        input.publicationId,
        input.publicationId,
        principal,
        requestId,
        requestId,
        requestId,
        principal,
        requestId,
        principal,
        input.publicationId,
        input.publicationId,
        principal,
        nowIso,
      ),
    db
      .prepare(
        `INSERT INTO asset_request_responses
          (id, request_id, responder, publication_id, message, created_at)
         SELECT ?, ?, ?, ?, ?, ? WHERE ${gate}`,
      )
      .bind(responseId, requestId, principal, input.publicationId, input.message, now, operation),
    db
      .prepare(
        `UPDATE asset_requests SET response_count = response_count + 1, updated_at = ?
         WHERE id = ? AND ${gate}`,
      )
      .bind(now, requestId, operation),
    db
      .prepare(
        `UPDATE mutation_requests SET response = (
          SELECT json_object(
            'id', resp.id,
            'requestId', resp.request_id,
            'responder', resp.responder,
            'publicationId', resp.publication_id,
            'publicationTitle', v.title,
            'message', resp.message,
            'createdAt', resp.created_at
          )
          FROM asset_request_responses resp
          LEFT JOIN publications p ON p.id = resp.publication_id AND p.state = 'published'
          LEFT JOIN versions v ON v.id = p.version_id
          WHERE resp.id = ?
        ) WHERE operation_id = ? AND status = 201`,
      )
      .bind(responseId, operation),
    db
      .prepare(
        `INSERT INTO asset_request_events
          (operation_id, request_id, actor, action, revision, created_at)
         SELECT ?, id, ?, 'responded', revision, ? FROM asset_requests WHERE id = ? AND ${gate}`,
      )
      .bind(operation, principal, now, requestId, operation),
    db
      .prepare(
        "SELECT fingerprint, status, response FROM mutation_requests WHERE principal = ? AND request_key = ?",
      )
      .bind(principal, key),
  ]);

  const receipt = results.at(-1)?.results[0];
  if (!receipt) throw new Error("MISSING_MUTATION_RECEIPT");
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return json(JSON.parse(receipt.response), receipt.status);
}
