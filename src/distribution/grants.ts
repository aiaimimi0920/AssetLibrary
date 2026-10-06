import { HttpError, json } from "../http";
import { loadPublication } from "../publications/records";

export interface GrantRow {
  publication_id: string;
  principal: string;
  state: "active" | "revoked";
  revision: number;
  last_operation: string;
}

export async function readGrant(db: D1Database, id: string, actor: string, principal: string) {
  const grant = await db
    .prepare(`SELECT g.* FROM download_grants g
    JOIN publications p ON p.id = g.publication_id JOIN versions v ON v.id = p.version_id
    JOIN resources r ON r.id = v.resource_id
    WHERE g.publication_id = ? AND g.principal = ? AND r.owner = ?`)
    .bind(id, principal, actor)
    .first<GrantRow>();
  if (!grant) throw new HttpError(404, "NOT_FOUND");
  return json({ publicationId: id, principal, state: grant.state, revision: grant.revision });
}

export async function downloadAuthority(db: D1Database, id: string, actor: string) {
  const row = await loadPublication(db, id);
  if (row.owner === actor) return { row, grantRevision: 0 };
  const grant = await db
    .prepare(`SELECT * FROM download_grants
    WHERE publication_id = ? AND principal = ? AND state = 'active'`)
    .bind(id, actor)
    .first<GrantRow>();
  if (!grant) throw new HttpError(404, "NOT_FOUND");
  return { row, grantRevision: grant.revision };
}

/** revision=0 只用于首次授权；撤销/重新授权保留墓碑，使旧票据永久失效。 */
export async function changeGrant(
  db: D1Database,
  id: string,
  actor: string,
  principal: string,
  revision: number,
  state: GrantRow["state"],
) {
  const row = await loadPublication(db, id);
  if (row.owner !== actor) throw new HttpError(404, "NOT_FOUND");
  if (principal === actor) throw new HttpError(400, "OWNER_GRANT_IMMUTABLE");
  const operation = crypto.randomUUID();
  const now = Date.now();
  const ownerGate = `EXISTS (SELECT 1 FROM publications p JOIN versions v ON v.id = p.version_id
    JOIN resources r ON r.id = v.resource_id WHERE p.id = ? AND r.owner = ?)`;
  const statements: D1PreparedStatement[] = [];
  if (revision === 0 && state === "active") {
    statements.push(
      db
        .prepare(`INSERT INTO download_grants
      (publication_id, principal, state, revision, updated_at, last_operation)
      SELECT ?, ?, 'active', 1, ?, ? WHERE ${ownerGate}
      AND EXISTS (SELECT 1 FROM publications WHERE id = ? AND state = 'published')
      ON CONFLICT(publication_id, principal) DO NOTHING`)
        .bind(id, principal, now, operation, id, actor, id),
    );
  } else {
    statements.push(
      db
        .prepare(`UPDATE download_grants SET state = ?, revision = revision + 1,
      updated_at = ?, last_operation = ? WHERE publication_id = ? AND principal = ?
      AND revision = ? AND state <> ? AND ${ownerGate}
      ${state === "active" ? "AND EXISTS (SELECT 1 FROM publications WHERE id = download_grants.publication_id AND state = 'published')" : ""}`)
        .bind(state, now, operation, id, principal, revision, state, id, actor),
    );
  }
  statements.push(
    db
      .prepare(`INSERT INTO download_grant_events
      (operation_id, publication_id, principal, actor, action, revision, created_at)
      SELECT ?, publication_id, principal, ?, state, revision, ? FROM download_grants WHERE last_operation = ?`)
      .bind(operation, actor, now, operation),
    db
      .prepare("SELECT * FROM download_grants WHERE publication_id = ? AND principal = ?")
      .bind(id, principal),
  );
  const result = (await db.batch<GrantRow>(statements)).at(-1)?.results[0];
  if (!result) throw new HttpError(409, "GRANT_REVISION_CONFLICT");
  const replay = result.state === state && result.revision === revision + 1;
  if (result.last_operation !== operation && !replay)
    throw new HttpError(409, "GRANT_REVISION_CONFLICT");
  return json({ publicationId: id, principal, state: result.state, revision: result.revision });
}
