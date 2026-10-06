import { HttpError, json } from "../http";
import { resourceJson } from "./queries";

export type Mutation =
  | { action: "create"; kind: "art" | "capability" | "application"; title: string }
  | { action: "update"; id: string; revision: number; title: string }
  | { action: "delete"; id: string; revision: number }
  | { action: "grant" | "revoke"; id: string; revision: number; member: string };

interface Receipt {
  fingerprint: string;
  status: number;
  response: string;
}

/** 每个批次先独占幂等键，再按同批权限判定执行；竞争失败不是 SQL 异常。 */
export async function mutate(db: D1Database, principal: string, key: string, input: Mutation) {
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) throw new HttpError(400, "INVALID_IDEMPOTENCY_KEY");
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(input)),
  );
  const fingerprint = [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const operation = crypto.randomUUID();
  const id = input.action === "create" ? crypto.randomUUID() : input.id;
  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];
  const claim = `INSERT INTO mutation_requests
    (principal, request_key, fingerprint, operation_id, status, created_at)
    VALUES (?, ?, ?, ?, `;
  const claimArgs = [principal, key, fingerprint, operation];
  if (input.action === "create") {
    statements.push(
      db
        .prepare(`${claim}201, ?) ON CONFLICT(principal, request_key) DO NOTHING`)
        .bind(...claimArgs, now),
    );
  } else {
    statements.push(
      db
        .prepare(`${claim}CASE
      WHEN NOT EXISTS (SELECT 1 FROM resources WHERE id = ? AND owner = ? AND state = 'draft') THEN 404
      WHEN NOT EXISTS (SELECT 1 FROM resources WHERE id = ? AND revision = ?) THEN 409
      ELSE 200 END, ?) ON CONFLICT(principal, request_key) DO NOTHING`)
        .bind(...claimArgs, id, principal, id, input.revision, now),
    );
  }
  // 重放已有键的批次没有本 operation_id，因此所有业务写入和审计均不执行。
  const gate = `EXISTS (SELECT 1 FROM mutation_requests WHERE operation_id = ? AND status < 300)`;
  if (input.action === "create") {
    statements.push(
      db
        .prepare(`INSERT INTO resources
      (id, owner, kind, title, state, revision, created_at, updated_at)
      SELECT ?, ?, ?, ?, 'draft', 1, ?, ? WHERE ${gate}`)
        .bind(id, principal, input.kind, input.title, now, now, operation),
    );
  } else {
    const assignment =
      input.action === "update"
        ? "title = ?, "
        : input.action === "delete"
          ? "state = 'deleted', "
          : "";
    const values =
      input.action === "update" ? [input.title, now, id, operation] : [now, id, operation];
    statements.push(
      db
        .prepare(`UPDATE resources SET ${assignment}
      revision = revision + 1, updated_at = ? WHERE id = ? AND ${gate}`)
        .bind(...values),
    );
    if (input.action === "grant") {
      statements.push(
        db
          .prepare(`INSERT INTO resource_members(resource_id, principal)
        SELECT ?, ? WHERE ${gate} ON CONFLICT(resource_id, principal) DO NOTHING`)
          .bind(id, input.member, operation),
      );
    } else if (input.action === "revoke") {
      statements.push(
        db
          .prepare(
            `DELETE FROM resource_members WHERE resource_id = ? AND principal = ? AND ${gate}`,
          )
          .bind(id, input.member, operation),
      );
    } else if (input.action === "delete") {
      statements.push(
        db
          .prepare(`DELETE FROM resource_members WHERE resource_id = ? AND ${gate}`)
          .bind(id, operation),
      );
    }
  }
  statements.push(
    db
      .prepare(`UPDATE mutation_requests SET response = CASE
    WHEN status < 300 THEN (SELECT ${resourceJson} FROM resources WHERE id = ?)
    WHEN status = 404 THEN '{"error":"NOT_FOUND"}'
    ELSE '{"error":"REVISION_CONFLICT"}' END WHERE operation_id = ?`)
      .bind(id, operation),
  );
  statements.push(
    db
      .prepare(`INSERT INTO audit_events
    (operation_id, principal, resource_id, action, revision, created_at)
    SELECT ?, ?, id, ?, revision, ? FROM resources WHERE id = ? AND ${gate}`)
      .bind(operation, principal, input.action, now, id, operation),
  );
  statements.push(
    db
      .prepare(`SELECT fingerprint, status, response FROM mutation_requests
    WHERE principal = ? AND request_key = ?`)
      .bind(principal, key),
  );

  // D1 batch 是原子事务；失败不缓存成功结果，不单独补写审计或重试业务写入。
  const results = await db.batch<Receipt>(statements);
  const receipt = results.at(-1)?.results[0];
  if (!receipt) throw new Error("MISSING_MUTATION_RECEIPT");
  if (receipt.fingerprint !== fingerprint) throw new HttpError(409, "IDEMPOTENCY_CONFLICT");
  return json(JSON.parse(receipt.response), receipt.status);
}
