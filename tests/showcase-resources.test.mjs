import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { hypotheticalPublication, ticketFor } from "./distribution-fixture.mjs";
import { createResource, fixture } from "./fixture.mjs";
import { chunk, header, png, signature } from "./inspection-fixture.mjs";
import { sha256 } from "./upload-fixture.mjs";
import { reviewerConfig } from "./version-fixture.mjs";

async function rawCover(
  f,
  resourceId,
  revision,
  bytes,
  { principal, key = randomUUID(), contentType = "image/png" } = {},
) {
  const token = await f.token(principal);
  return f.mf.dispatchFetch(
    `http://localhost/v1/resources/${resourceId}/cover?revision=${revision}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": contentType,
        "idempotency-key": key,
      },
      body: bytes,
    },
  );
}

test("展示资料与静态 PNG 封面：边界校验、幂等、权限隔离及审计一致", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const resource = await createResource(f);
    assert.deepEqual(resource.profile, {
      space: "general",
      summary: "",
      detail: "",
      cover: null,
    });
    for (const invalid of [
      { revision: 1, space: "games", summary: "ok", detail: "" },
      { revision: 1, space: "__proto__", summary: "ok", detail: "" },
      { revision: 1, space: "loom", summary: "a".repeat(161), detail: "" },
      { revision: 1, space: "loom", summary: "bad\u0000text", detail: "" },
      { revision: 1, space: "loom", summary: "ok", detail: "a".repeat(2001) },
      { revision: 1, space: "loom", summary: "ok", detail: "bad\u0007bell" },
      { revision: 1, space: "loom", summary: "ok", detail: "", extra: true },
    ]) {
      assert.equal(
        (await f.request("PUT", `/v1/resources/${resource.id}/profile`, invalid)).status,
        400,
      );
    }
    const profileKey = "profile-idempotency-key-1";
    const profileBody = {
      revision: 1,
      space: "framelab",
      summary: "  高动态色调映射滤镜组  ",
      detail: "第一段说明\r\n第二段适用环境说明  ",
    };
    const updated = await f.request("PUT", `/v1/resources/${resource.id}/profile`, profileBody, {
      key: profileKey,
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.revision, 2);
    assert.deepEqual(updated.body.profile, {
      space: "framelab",
      summary: "高动态色调映射滤镜组",
      detail: "第一段说明\n第二段适用环境说明",
      cover: null,
    });
    const replayed = await f.request("PUT", `/v1/resources/${resource.id}/profile`, profileBody, {
      key: profileKey,
    });
    assert.deepEqual(replayed.body, updated.body);
    assert.equal(
      (
        await f.request(
          "PUT",
          `/v1/resources/${resource.id}/profile`,
          { ...profileBody, space: "otter" },
          { key: profileKey },
        )
      ).status,
      409,
    );

    const coverBytes = png(16, 9);
    assert.equal(
      (await rawCover(f, resource.id, 2, coverBytes, { contentType: "image/jpeg" })).status,
      415,
    );
    assert.equal((await rawCover(f, resource.id, 2, new Uint8Array(0))).status, 400);
    assert.equal((await rawCover(f, resource.id, 2, new Uint8Array(1048577))).status, 413);
    const ancillaryPng = Buffer.concat([
      signature,
      header(2, 2),
      chunk("tEXt", Buffer.from("Comment\0unsafe")),
      chunk("IEND"),
    ]);
    assert.equal((await rawCover(f, resource.id, 2, ancillaryPng)).status, 422);
    assert.equal(
      (await rawCover(f, resource.id, 2, coverBytes, { principal: "user:eve" })).status,
      404,
    );
    assert.deepEqual((await f.bucket.list()).objects, []);

    const coverKey = "cover-idempotency-key-1";
    const uploadedCover = await rawCover(f, resource.id, 2, coverBytes, { key: coverKey });
    assert.equal(uploadedCover.status, 200);
    const withCover = await uploadedCover.json();
    assert.equal(withCover.revision, 3);
    assert.equal(withCover.profile.space, "framelab");
    assert.deepEqual(withCover.profile.cover, {
      sha256: sha256(coverBytes),
      size: coverBytes.length,
      width: 16,
      height: 9,
      url: `/v1/resources/${resource.id}/cover`,
    });
    const replayCover = await rawCover(f, resource.id, 2, coverBytes, { key: coverKey });
    assert.equal(replayCover.status, 200);
    assert.deepEqual(await replayCover.json(), withCover);
    assert.equal((await rawCover(f, resource.id, 2, png(4, 4), { key: coverKey })).status, 409);

    await f.request("PUT", `/v1/resources/${resource.id}/members/user:bob`, { revision: 3 });
    for (const principal of ["user:alice", "user:bob"]) {
      const readRes = await f.mf.dispatchFetch(
        `http://localhost/v1/resources/${resource.id}/cover`,
        { headers: { authorization: `Bearer ${await f.token(principal)}` } },
      );
      assert.equal(readRes.status, 200);
      assert.equal(readRes.headers.get("content-type"), "image/png");
      assert.equal(readRes.headers.get("content-security-policy"), "default-src 'none'");
      assert.equal(Buffer.from(await readRes.arrayBuffer()).equals(coverBytes), true);
    }
    assert.equal(
      (
        await f.mf.dispatchFetch(`http://localhost/v1/resources/${resource.id}/cover`, {
          headers: { authorization: `Bearer ${await f.token("user:eve")}` },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          "PUT",
          `/v1/resources/${resource.id}/profile`,
          { revision: 4, space: "loom", summary: "篡改", detail: "" },
          { principal: "user:bob" },
        )
      ).status,
      404,
    );

    const cleared = await f.request("DELETE", `/v1/resources/${resource.id}/cover`, {
      revision: 4,
    });
    assert.equal(cleared.status, 200);
    assert.equal(cleared.body.revision, 5);
    assert.equal(cleared.body.profile.cover, null);
    assert.equal(cleared.body.profile.summary, "高动态色调映射滤镜组");
    const audits = await f.db
      .prepare("SELECT action, revision FROM audit_events WHERE resource_id = ? ORDER BY revision")
      .bind(resource.id)
      .all();
    assert.deepEqual(
      audits.results.map((r) => [r.action, r.revision]),
      [
        ["create", 1],
        ["profile", 2],
        ["cover", 3],
        ["grant", 4],
        ["clear_cover", 5],
      ],
    );
  } finally {
    await f.dispose();
  }
});

test("0013_showcase_spaces.sql 保数据增量迁移：失败回滚、重复执行幂等且迁移后立即可读写", async () => {
  const f = await fixture({ schema: false, reviewers: reviewerConfig });
  const sqlFile = (name) => readFile(new URL(`../db/${name}`, import.meta.url), "utf8");
  const statements = (db, sql) =>
    sql
      .split(";")
      .filter((part) => part.trim())
      .map((part) => db.prepare(part));
  async function snapshot(db) {
    const tables = (
      await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name",
        )
        .all()
    ).results;
    const result = {};
    for (const { name } of tables) {
      result[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results
        .map((row) => JSON.stringify(row))
        .sort();
    }
    return result;
  }
  try {
    const prior = (await readdir(new URL("../db/", import.meta.url)))
      .filter((name) => name.endsWith(".sql") && name < "0013_showcase_spaces.sql")
      .sort();
    for (const name of prior) await f.db.batch(statements(f.db, await sqlFile(name)));
    const { publication } = await hypotheticalPublication(f, { member: "user:bob" });
    await ticketFor(f, publication);
    const before = await snapshot(f.db);
    const migration = await sqlFile("0013_showcase_spaces.sql");
    await assert.rejects(
      f.db.batch([
        ...statements(f.db, migration),
        f.db.prepare("INSERT INTO nonexistent_migration_probe VALUES (1)"),
      ]),
    );
    assert.deepEqual(await snapshot(f.db), before);
    await f.db.batch(statements(f.db, migration));
    const expected = {
      ...before,
      resource_profiles: [],
      version_profiles: [],
    };
    assert.deepEqual(await snapshot(f.db), expected);
    await f.db.batch(statements(f.db, migration));
    assert.deepEqual(await snapshot(f.db), expected);
    assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    const legacyDetail = await f.request("GET", `/v1/publications/${publication.id}`);
    assert.equal(legacyDetail.status, 200);
    assert.equal(legacyDetail.body.space, "general");
    assert.equal(legacyDetail.body.cover, null);
    const created = await createResource(f);
    const migratedWrite = await f.request("PUT", `/v1/resources/${created.id}/profile`, {
      revision: 1,
      space: "loom",
      summary: "迁移后立即可写",
      detail: "",
    });
    assert.equal(migratedWrite.status, 200);
    assert.equal(migratedWrite.body.profile.space, "loom");
  } finally {
    await f.dispose();
  }
});
