import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  contentRequest,
  coreModules,
  denied,
  hypotheticalPublication,
  ticketFor,
} from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { sha256 } from "./upload-fixture.mjs";
import { reviewerConfig } from "./version-fixture.mjs";

let f;
let core;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
  core = await coreModules();
});
after(async () => {
  await f?.dispose();
});

test("假设部署准入：双 PNG ZIP 上传→审核→发布→授权流式下载字节完全一致", async () => {
  const { bytes, publication } = await hypotheticalPublication(f, { member: "user:bob" });
  await denied(core.issueTicket(f.db, publication.id, "user:bob"));
  assert.equal(
    (
      await f.request("GET", `/v1/resources/${publication.resourceId}`, undefined, {
        principal: "user:bob",
      })
    ).status,
    200,
  );
  assert.equal(
    (await f.request("PUT", `/v1/publications/${publication.id}/grants/user:bob`, { revision: 0 }))
      .status,
    200,
  );
  const ticket = await ticketFor(f, publication, "user:bob");
  const response = await core.downloadContent(
    contentRequest(publication, ticket),
    f.env,
    publication.id,
    "user:bob",
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("content-type"), "application/zip");
  assert.equal(Number(response.headers.get("content-length")), bytes.length);
  const actual = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(actual, bytes);
  assert.equal(sha256(actual), publication.sha256);
  const stored = await f.db
    .prepare("SELECT token_hash FROM download_tickets WHERE publication_id = ?")
    .bind(publication.id)
    .first();
  assert.notEqual(stored.token_hash, ticket.ticket);
  assert.equal(stored.token_hash, await core.ticketHash(ticket.ticket));
  await denied(core.authorizeTicket(f.db, publication.id, "user:alice", ticket.ticket));
  await denied(core.authorizeTicket(f.db, publication.id, "user:eve", ticket.ticket));
  const library = await (
    await core.listPublications(f.db, new URL("http://local/v1/me/library"), "user:bob")
  ).json();
  assert.deepEqual(
    library.items.map((r) => r.id),
    [publication.id],
  );
});

test("单 Range、suffix、If-Range、HEAD 和不合法范围有明确响应", async () => {
  const { bytes, publication } = await hypotheticalPublication(f);
  const ticket = await ticketFor(f, publication);
  for (const [range, start, end] of [
    ["bytes=3-11", 3, 12],
    ["bytes=5-", 5, bytes.length],
    ["bytes=-9", bytes.length - 9, bytes.length],
    ["bytes=0-999999", 0, bytes.length],
  ]) {
    const response = await core.downloadContent(
      contentRequest(publication, ticket, { headers: { range } }),
      f.env,
      publication.id,
      "user:alice",
    );
    assert.equal(response.status, 206);
    assert.equal(
      response.headers.get("content-range"),
      `bytes ${start}-${end - 1}/${bytes.length}`,
    );
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes.subarray(start, end));
  }
  const head = await core.downloadContent(
    contentRequest(publication, ticket, { method: "HEAD", headers: { range: "bytes=0-3" } }),
    f.env,
    publication.id,
    "user:alice",
  );
  assert.equal(head.status, 200);
  assert.equal(head.body, null);
  assert.equal(Number(head.headers.get("content-length")), bytes.length);
  const full = await core.downloadContent(
    contentRequest(publication, ticket, { headers: { range: "bytes=0-3", "if-range": '"wrong"' } }),
    f.env,
    publication.id,
    "user:alice",
  );
  assert.equal(full.status, 200);
  assert.deepEqual(Buffer.from(await full.arrayBuffer()), bytes);
  const etag = full.headers.get("etag");
  const partial = await core.downloadContent(
    contentRequest(publication, ticket, { headers: { range: "bytes=0-3", "if-range": etag } }),
    f.env,
    publication.id,
    "user:alice",
  );
  assert.equal(partial.status, 206);
  assert.equal((await partial.arrayBuffer()).byteLength, 4);
  for (const range of [
    "bytes=1-2,3-4",
    "bytes=-0",
    "bytes=9-2",
    "bytes=9999999-",
    "bytes=9007199254740993-",
    "items=0-1",
    `bytes=${"1".repeat(129)}-`,
  ]) {
    const response = await core.downloadContent(
      contentRequest(publication, ticket, { headers: { range } }),
      f.env,
      publication.id,
      "user:alice",
    );
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("content-range"), `bytes */${bytes.length}`);
  }
});

test("授权撤销后新请求/续传拒绝；重新授权不能复活旧票据", async () => {
  const { publication } = await hypotheticalPublication(f);
  const path = `/v1/publications/${publication.id}/grants/user:bob`;
  assert.equal((await f.request("PUT", path, { revision: 0 })).body.revision, 1);
  const ticket = await ticketFor(f, publication, "user:bob");
  const revoked = await f.request("DELETE", path, { revision: 1 });
  assert.equal(revoked.body.state, "revoked");
  assert.equal(revoked.body.revision, 2);
  assert.equal((await f.request("DELETE", path, { revision: 1 })).body.revision, 2);
  await denied(core.issueTicket(f.db, publication.id, "user:bob"));
  await denied(
    core.downloadContent(
      contentRequest(publication, ticket, { headers: { range: "bytes=0-3" } }),
      f.env,
      publication.id,
      "user:bob",
    ),
  );
  assert.equal((await f.request("PUT", path, { revision: 2 })).body.revision, 3);
  await denied(core.authorizeTicket(f.db, publication.id, "user:bob", ticket.ticket));
  const fresh = await ticketFor(f, publication, "user:bob");
  assert.equal(
    (await core.authorizeTicket(f.db, publication.id, "user:bob", fresh.ticket)).id,
    publication.id,
  );
});

test("下架和票据到期使新请求/续传失效，过期清理有界且保留发布历史", async () => {
  const { publication } = await hypotheticalPublication(f);
  const ticket = await ticketFor(f, publication);
  await f.db
    .prepare("UPDATE download_tickets SET expires_at = 0 WHERE token_hash = ?")
    .bind(await core.ticketHash(ticket.ticket))
    .run();
  await denied(core.authorizeTicket(f.db, publication.id, "user:alice", ticket.ticket));
  await core.expireTickets(f.db);
  assert.equal(
    await f.db
      .prepare("SELECT token_hash FROM download_tickets WHERE token_hash = ?")
      .bind(await core.ticketHash(ticket.ticket))
      .first(),
    null,
  );
  const another = await ticketFor(f, publication);
  await core.unlistPublication(f.db, publication.id, "user:alice", 1);
  await denied(
    core.downloadContent(
      contentRequest(publication, another, { headers: { range: "bytes=0-3" } }),
      f.env,
      publication.id,
      "user:alice",
    ),
  );
  await denied(core.publicDetail(f.db, publication.id));
  assert.equal((await core.loadPublication(f.db, publication.id)).state, "unlisted");
});
