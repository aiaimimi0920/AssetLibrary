import { HttpError, json } from "../http";
import {
  isDistributable,
  type PublicationRow,
  publicationScan,
  publicationSelect,
} from "../publications/records";
import { downloadAuthority } from "./grants";

export async function ticketHash(token: string) {
  if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(404, "NOT_FOUND");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** 票据仅保存摘要；主体、对象、发布及授权 revision 在同一事务重新绑定。 */
export async function issueTicket(db: D1Database, id: string, actor: string) {
  const { row, grantRevision } = await downloadAuthority(db, id, actor);
  if (!isDistributable(row)) throw new HttpError(404, "NOT_FOUND");
  const scan = publicationScan(row);
  if (!scan) throw new HttpError(404, "NOT_FOUND");
  const token = [...crypto.getRandomValues(new Uint8Array(32))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const hash = await ticketHash(token);
  const now = Date.now();
  const expiresAt = Math.min(now + 300000, scan.expiresAt);
  const result = await db
    .prepare(`INSERT INTO download_tickets
    (token_hash, principal, publication_id, publication_revision, version_revision,
      grant_revision, sha256, etag, expires_at, created_at)
    SELECT ?, ?, id, revision, version_revision, ?, sha256, etag, ?, ?
    FROM (${publicationSelect}) eligible WHERE id = ? AND state = 'published' AND binding_current = 1
    AND revision = ? AND scan_result = ? AND ? > ? AND
    ((owner = ? AND ? = 0) OR EXISTS (SELECT 1 FROM download_grants g
      WHERE g.publication_id = eligible.id AND g.principal = ? AND g.state = 'active' AND g.revision = ?))`)
    .bind(
      hash,
      actor,
      grantRevision,
      expiresAt,
      now,
      id,
      row.revision,
      row.scan_result,
      expiresAt,
      now,
      actor,
      grantRevision,
      actor,
      grantRevision,
    )
    .run();
  if (result.meta.changes !== 1) throw new HttpError(404, "NOT_FOUND");
  return json(
    { publicationId: id, ticket: token, expiresAt, contentPath: `/v1/publications/${id}/content` },
    201,
  );
}

export async function authorizeTicket(db: D1Database, id: string, actor: string, token: string) {
  const hash = await ticketHash(token);
  // 主体/撤销/票据在一条 primary 查询内判断，避免多次读取之间的授权竞争。
  const row = await db
    .prepare(`SELECT eligible.* FROM (${publicationSelect}) eligible
    JOIN download_tickets t ON t.publication_id = eligible.id
    WHERE eligible.id = ? AND t.token_hash = ? AND t.principal = ? AND t.expires_at > ?
    AND eligible.state = 'published' AND eligible.binding_current = 1
    AND t.publication_revision = eligible.revision AND t.version_revision = eligible.version_revision
    AND t.sha256 = eligible.sha256 AND t.etag = eligible.etag
    AND ((eligible.owner = ? AND t.grant_revision = 0) OR EXISTS
      (SELECT 1 FROM download_grants g WHERE g.publication_id = eligible.id
      AND g.principal = ? AND g.state = 'active' AND g.revision = t.grant_revision))`)
    .bind(id, hash, actor, Date.now(), actor, actor)
    .first<PublicationRow>();
  if (!row || !isDistributable(row)) throw new HttpError(404, "NOT_FOUND");
  return row;
}

/** 仅回收过期票据，不删除发布、授权、事件或 R2 字节。 */
export async function expireTickets(db: D1Database) {
  const result = await db
    .prepare(`DELETE FROM download_tickets WHERE token_hash IN
    (SELECT token_hash FROM download_tickets WHERE expires_at <= ? ORDER BY expires_at, token_hash LIMIT 100)`)
    .bind(Date.now())
    .run();
  return result.meta.changes;
}
