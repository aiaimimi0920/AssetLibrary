import { hasAssetMarketSchema } from "../assets/taxonomy";
import { HttpError, json, revision } from "../http";
import { ContentRejected, inspectPng } from "../inspections/png";
import { maxObjectSize } from "../inspections/records";
import { coverStreamResponse, hasShowcaseSchema } from "../spaces/catalog";
import { resourceJoinsFor, resourceJsonFor } from "./queries";

export interface ResourceCoverEnv {
  DB: D1Database;
  QUARANTINE: R2Bucket;
}

interface Receipt {
  fingerprint: string;
  status: number;
  response: string;
}

async function readBoundedBytes(request: Request, limit: number): Promise<Uint8Array> {
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_COVER_IMAGE");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => {});
        throw new HttpError(413, "COVER_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (size < 1) throw new HttpError(400, "INVALID_COVER_IMAGE");
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function hex(buffer: ArrayBuffer): string {
  return [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** 封面上传同步完成静态 RGBA8 PNG 校验，递增资源 revision 以阻止未经审核替换已发布封面。 */
export async function putResourceCover(
  request: Request,
  env: ResourceCoverEnv,
  id: string,
  principal: string,
) {
  const url = new URL(request.url);
  const revText = url.searchParams.get("revision");
  if (
    revText === null ||
    !/^[1-9][0-9]*$/.test(revText) ||
    url.searchParams.getAll("revision").length !== 1 ||
    [...url.searchParams.keys()].some((name) => name !== "revision")
  )
    throw new HttpError(400, "INVALID_REVISION");
  const expectedRevision = revision(Number(revText));
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY");
  const mediaType = request.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
  if (!["image/png", "application/octet-stream"].includes(mediaType))
    throw new HttpError(415, "PNG_REQUIRED");
  const bytes = await readBoundedBytes(request, maxObjectSize);
  const sha256 = hex(await crypto.subtle.digest("SHA-256", bytes));
  const fingerprint = hex(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(
        JSON.stringify({
          action: "cover",
          id,
          revision: expectedRevision,
          size: bytes.byteLength,
          sha256,
        }),
      ),
    ),
  );
  const existing = await env.DB.prepare(
    "SELECT fingerprint, status, response FROM mutation_requests WHERE principal = ? AND request_key = ?",
  )
    .bind(principal, key)
    .first<Receipt>();
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
    return json(JSON.parse(existing.response), existing.status);
  }
  let png: Awaited<ReturnType<typeof inspectPng>>;
  try {
    png = await inspectPng(bytes, 1048576);
  } catch (error) {
    if (error instanceof ContentRejected) throw new HttpError(422, error.code);
    throw error;
  }
  const owned = await env.DB.prepare(
    "SELECT revision FROM resources WHERE id = ? AND owner = ? AND state = 'draft'",
  )
    .bind(id, principal)
    .first<{ revision: number }>();
  const coverKey = `covers/${id}/${sha256}.png`;
  if (owned && owned.revision === expectedRevision) {
    await env.QUARANTINE.put(coverKey, bytes, { sha256 });
  }
  const [showcase, assetMarket] = await Promise.all([
    hasShowcaseSchema(env.DB),
    hasAssetMarketSchema(env.DB),
  ]);
  const operation = crypto.randomUUID();
  const now = new Date().toISOString();
  const gate = "EXISTS (SELECT 1 FROM mutation_requests WHERE operation_id = ? AND status < 300)";
  const results = await env.DB.batch<Receipt>([
    env.DB.prepare(`INSERT INTO mutation_requests
      (principal, request_key, fingerprint, operation_id, status, created_at)
      VALUES (?, ?, ?, ?, CASE
        WHEN NOT EXISTS (SELECT 1 FROM resources WHERE id = ? AND owner = ? AND state = 'draft') THEN 404
        WHEN NOT EXISTS (SELECT 1 FROM resources WHERE id = ? AND revision = ?) THEN 409
        ELSE 200 END, ?) ON CONFLICT(principal, request_key) DO NOTHING`).bind(
      principal,
      key,
      fingerprint,
      operation,
      id,
      principal,
      id,
      expectedRevision,
      now,
    ),
    env.DB.prepare(
      `UPDATE resources SET revision = revision + 1, updated_at = ? WHERE id = ? AND ${gate}`,
    ).bind(now, id, operation),
    env.DB.prepare(`INSERT INTO resource_profiles
      (resource_id, space, summary, detail, cover_key, cover_sha256, cover_size, cover_width, cover_height)
      SELECT ?, 'general', '', '', ?, ?, ?, ?, ? WHERE ${gate}
      ON CONFLICT(resource_id) DO UPDATE SET
        cover_key = excluded.cover_key,
        cover_sha256 = excluded.cover_sha256,
        cover_size = excluded.cover_size,
        cover_width = excluded.cover_width,
        cover_height = excluded.cover_height`).bind(
      id,
      coverKey,
      sha256,
      bytes.byteLength,
      png.width,
      png.height,
      operation,
    ),
    env.DB.prepare(`UPDATE mutation_requests SET response = CASE
      WHEN status < 300 THEN (
        SELECT ${resourceJsonFor(showcase, assetMarket)} FROM resources r
        ${resourceJoinsFor(showcase, assetMarket)} WHERE r.id = ?
      )
      WHEN status = 404 THEN '{"error":"NOT_FOUND"}'
      ELSE '{"error":"REVISION_CONFLICT"}' END WHERE operation_id = ?`).bind(id, operation),
    env.DB.prepare(`INSERT INTO audit_events
      (operation_id, principal, resource_id, action, revision, created_at)
      SELECT ?, ?, id, 'cover', revision, ? FROM resources WHERE id = ? AND ${gate}`).bind(
      operation,
      principal,
      now,
      id,
      operation,
    ),
    env.DB.prepare(
      "SELECT fingerprint, status, response FROM mutation_requests WHERE principal = ? AND request_key = ?",
    ).bind(principal, key),
  ]);
  const receipt = results.at(-1)?.results[0];
  if (!receipt) throw new Error("MISSING_MUTATION_RECEIPT");
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return json(JSON.parse(receipt.response), receipt.status);
}

export async function getResourceCover(
  request: Request,
  env: ResourceCoverEnv,
  id: string,
  principal: string,
) {
  if (new URL(request.url).search) throw new HttpError(400, "INVALID_QUERY");
  const row = await env.DB.prepare(`SELECT rp.cover_key, rp.cover_sha256, rp.cover_size
    FROM resources r JOIN resource_profiles rp ON rp.resource_id = r.id
    WHERE r.id = ? AND r.state = 'draft' AND rp.cover_key IS NOT NULL
    AND (r.owner = ? OR EXISTS (SELECT 1 FROM resource_members m
      WHERE m.resource_id = r.id AND m.principal = ?))`)
    .bind(id, principal, principal)
    .first<{ cover_key: string; cover_sha256: string; cover_size: number }>();
  if (!row) throw new HttpError(404, "NOT_FOUND");
  return coverStreamResponse(
    env.QUARANTINE,
    row.cover_key,
    row.cover_sha256,
    row.cover_size,
    request.method === "HEAD",
  );
}
