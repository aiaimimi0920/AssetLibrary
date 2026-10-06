import { exactFields, HttpError, json, readJson } from "../http";
import { uploadJson } from "./records";

export async function reserveUpload(
  request: Request,
  db: D1Database,
  resourceId: string,
  principal: string,
) {
  const body = await readJson(request);
  exactFields(body, ["size", "sha256"]);
  if (
    !Number.isSafeInteger(body.size) ||
    Number(body.size) < 1 ||
    Number(body.size) > 16 * 1024 * 1024
  )
    throw new HttpError(400, "INVALID_UPLOAD_SIZE");
  if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256))
    throw new HttpError(400, "INVALID_SHA256");
  const key = request.headers.get("idempotency-key") ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        action: "reserve-upload",
        resourceId,
        size: body.size,
        sha256: body.sha256,
      }),
    ),
  );
  const fingerprint = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const id = crypto.randomUUID();
  const operation = crypto.randomUUID();
  const now = Date.now();
  const gate = "EXISTS (SELECT 1 FROM mutation_requests WHERE operation_id = ? AND status = 201)";
  const results = await db.batch<{ fingerprint: string; status: number; response: string }>([
    db
      .prepare(`INSERT INTO mutation_requests(principal, request_key, fingerprint, operation_id, status, created_at)
      VALUES (?, ?, ?, ?, CASE WHEN EXISTS (SELECT 1 FROM resources
        WHERE id = ? AND owner = ? AND state = 'draft') THEN 201 ELSE 404 END, ?)
      ON CONFLICT(principal, request_key) DO NOTHING`)
      .bind(
        principal,
        key,
        fingerprint,
        operation,
        resourceId,
        principal,
        new Date(now).toISOString(),
      ),
    db
      .prepare(`INSERT INTO uploads(id, resource_id, owner, expected_size, sha256, state,
      revision, expires_at, reconcile_at, created_at, updated_at, last_operation)
      SELECT ?, ?, ?, ?, ?, 'pending', 1, ?, ?, ?, ?, ? WHERE ${gate}`)
      .bind(
        id,
        resourceId,
        principal,
        body.size,
        body.sha256,
        now + 900000,
        now + 60000,
        now,
        now,
        operation,
        operation,
      ),
    db
      .prepare(`INSERT INTO upload_events(operation_id, upload_id, actor, state, revision, created_at)
      SELECT ?, id, ?, state, revision, ? FROM uploads WHERE id = ? AND ${gate}`)
      .bind(operation, principal, now, id, operation),
    db
      .prepare(`UPDATE mutation_requests SET response = CASE WHEN status = 201
      THEN (SELECT ${uploadJson} FROM uploads WHERE id = ?) ELSE '{"error":"NOT_FOUND"}' END
      WHERE operation_id = ?`)
      .bind(id, operation),
    db
      .prepare(
        "SELECT fingerprint, status, response FROM mutation_requests WHERE principal = ? AND request_key = ?",
      )
      .bind(principal, key),
  ]);
  const receipt = results.at(-1)?.results[0];
  if (!receipt) throw new Error("MISSING_UPLOAD_RECEIPT");
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return json(JSON.parse(receipt.response), receipt.status);
}
