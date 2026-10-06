import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { coreModules, denied, hypotheticalPublication } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
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

test("授权 CAS 与并发重放仅写一次成功事件；owner、目录成员和输入边界分开", async () => {
  const { publication } = await hypotheticalPublication(f);
  const path = `/v1/publications/${publication.id}/grants/user:bob`;
  assert.equal(
    (await f.request("PUT", path, { revision: 0 }, { principal: "user:eve" })).status,
    404,
  );
  const results = await Promise.all(
    Array.from({ length: 4 }, () => f.request("PUT", path, { revision: 0 })),
  );
  assert.ok(results.every((r) => r.status === 200 && r.body.revision === 1));
  assert.equal((await f.request("GET", path)).body.revision, 1);
  assert.equal((await f.request("GET", path, undefined, { principal: "user:bob" })).status, 404);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM download_grant_events WHERE publication_id = ?")
        .bind(publication.id)
        .first()
    ).n,
    1,
  );
  assert.equal(
    (await f.request("DELETE", path, { revision: 7 })).body.error,
    "GRANT_REVISION_CONFLICT",
  );
  for (const body of [
    { revision: -1 },
    { revision: 0.5 },
    { revision: 2147483647 },
    { revision: 0, role: "owner" },
  ])
    assert.equal((await f.request("PUT", path, body)).status, 400);
  assert.equal((await f.request("DELETE", path, { revision: 0 })).status, 400);
  assert.equal(
    (
      await f.request("PUT", `/v1/publications/${publication.id}/grants/user:alice`, {
        revision: 0,
      })
    ).body.error,
    "OWNER_GRANT_IMMUTABLE",
  );
  assert.equal(
    (
      await f.request("PUT", `/v1/publications/${publication.id}/grants/bad%20principal`, {
        revision: 0,
      })
    ).status,
    400,
  );
});

test("授权审计 ABORT 回滚，撤销也不允许单独提交业务状态", async () => {
  const { publication } = await hypotheticalPublication(f);
  const path = `/v1/publications/${publication.id}/grants/user:bob`;
  for (const [method, revision] of [
    ["PUT", 0],
    ["DELETE", 1],
  ]) {
    await f.db
      .prepare(
        "CREATE TRIGGER fail_grant BEFORE INSERT ON download_grant_events BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_GRANT'); END",
      )
      .run();
    try {
      assert.equal((await f.request(method, path, { revision })).status, 503);
      const row = await f.db
        .prepare(
          "SELECT state, revision FROM download_grants WHERE publication_id = ? AND principal = 'user:bob'",
        )
        .bind(publication.id)
        .first();
      assert.deepEqual(row, revision === 0 ? null : { state: "active", revision: 1 });
    } finally {
      await f.db.prepare("DROP TRIGGER fail_grant").run();
    }
    assert.equal((await f.request(method, path, { revision })).status, 200);
  }
});

test("有界公开目录/资源库不暴露私有字段，失效项不会卡住分页游标", async () => {
  const entries = await Promise.all(Array.from({ length: 3 }, () => hypotheticalPublication(f)));
  entries.sort((a, b) => a.publication.id.localeCompare(b.publication.id));
  await core.unlistPublication(f.db, entries[0].publication.id, "user:alice", 1);
  await f.db
    .prepare("UPDATE publications SET scan_result = '{}' WHERE id = ?")
    .bind(entries[1].publication.id)
    .run();
  let after = "";
  const found = [];
  for (let page = 0; page < 20; page++) {
    const result = await (
      await core.listPublications(
        f.db,
        new URL(`http://local/v1/catalog?limit=1${after ? `&after=${after}` : ""}`),
      )
    ).json();
    found.push(...result.items);
    if (!result.nextAfter) break;
    assert.notEqual(result.nextAfter, after);
    after = result.nextAfter;
  }
  assert.ok(found.some((row) => row.id === entries[2].publication.id));
  assert.ok(
    !found.some((row) => entries.slice(0, 2).some((entry) => entry.publication.id === row.id)),
  );
  for (const row of found) {
    assert.equal(row.owner, undefined);
    assert.equal(row.uploadId, undefined);
    assert.equal(row.etag, undefined);
    assert.equal(row.scan_result, undefined);
  }
  assert.deepEqual(
    (
      await (
        await core.listPublications(f.db, new URL("http://local/v1/me/library"), "user:eve")
      ).json()
    ).items,
    [],
  );
  for (const query of [
    "limit=51",
    "limit=0",
    "limit=1&limit=2",
    "after=bad",
    "owner=user:alice",
    "after=&after=",
  ])
    await denied(
      core.listPublications(f.db, new URL(`http://local/v1/catalog?${query}`)),
      "INVALID_PAGE",
    );
});
