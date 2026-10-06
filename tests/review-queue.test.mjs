import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { fixture } from "./fixture.mjs";
import {
  callWithEnv,
  events,
  readyVersion,
  review,
  reviewerConfig,
  withdraw,
} from "./version-fixture.mjs";

const queue = (f, query = "", principal = "user:reviewer") =>
  f.request("GET", `/v1/reviews${query}`, undefined, { principal });

test("增量索引应用前后业务事实与队列结果不变，旧查询无需删除索引即可继续使用", async () => {
  const f = await fixture({ schema: false, reviewers: reviewerConfig });
  try {
    const directory = new URL("../db/", import.meta.url);
    async function apply(name) {
      const sql = await readFile(new URL(name, directory), "utf8");
      await f.db.batch(
        sql
          .split(";")
          .filter((part) => part.trim())
          .map((part) => f.db.prepare(part)),
      );
    }
    for (const name of (await readdir(directory))
      .filter((name) => name.endsWith(".sql") && name < "0007")
      .sort())
      await apply(name);
    const { version } = await readyVersion(f);
    async function facts() {
      const data = {};
      for (const table of ["resources", "uploads", "inspections", "versions", "version_events"])
        data[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
      return data;
    }
    const before = await facts();
    const page = (await queue(f)).body;
    await apply("0007_review_queue.sql");
    assert.deepEqual(await facts(), before);
    assert.deepEqual((await queue(f)).body, page);
    const owned = await f.request("GET", `/v1/resources/${version.resourceId}/versions`);
    assert.equal(owned.body.items[0].id, version.id);
    assert.equal((await review(f, version)).status, 200);
  } finally {
    await f.dispose();
  }
});

test("审核队列只向当前配置审核者返回他人活动待办，拒绝未授权及自审", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const { version } = await readyVersion(f);
    const page = await queue(f);
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 1);
    assert.equal(page.body.items[0].id, version.id);
    assert.equal(page.body.items[0].owner, "user:alice");
    assert.equal(page.body.items[0].publicationEligible, false);
    assert.equal(page.body.nextCursor, null);
    assert.deepEqual((await queue(f, "", "user:alice")).body.items, []);
    assert.equal((await queue(f, "", "user:bob")).status, 404);
    assert.equal((await f.request("GET", "/v1/reviews", undefined, { token: null })).status, 401);
    assert.equal(
      (await review(f, version, {}, { principal: "user:alice" })).body.error,
      "SELF_REVIEW_FORBIDDEN",
    );
    assert.equal((await events(f, version)).length, 1);
  } finally {
    await f.dispose();
  }
});

test("审核队列 UUID 分页无重复，批准、拒绝、撤回后退出，旧决定不能覆盖新决定", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const versions = [];
    for (let i = 0; i < 3; i++) versions.push((await readyVersion(f)).version);
    const ids = [];
    let after = "";
    do {
      const page = await queue(f, `?limit=1${after ? `&after=${after}` : ""}`);
      assert.equal(page.status, 200);
      assert.equal(page.body.items.length, 1);
      ids.push(page.body.items[0].id);
      after = page.body.nextCursor;
    } while (after);
    assert.deepEqual(ids, versions.map((v) => v.id).sort());
    assert.equal((await review(f, versions[0])).status, 200);
    const conflict = await review(
      f,
      versions[0],
      { decision: "rejected" },
      { principal: "user:reviewer2" },
    );
    assert.equal(conflict.status, 409);
    assert.equal((await review(f, versions[1], { decision: "rejected" })).status, 200);
    assert.equal((await withdraw(f, versions[2])).status, 200);
    assert.deepEqual((await queue(f)).body, { items: [], nextCursor: null });
    assert.equal((await events(f, versions[0])).length, 2);
  } finally {
    await f.dispose();
  }
});

test("过期绑定保留可拒绝待办但不能批准，删除资源后不再出现在待办", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const { version } = await readyVersion(f);
    assert.equal(
      (
        await f.request("PUT", `/v1/resources/${version.resourceId}/members/user:bob`, {
          revision: 1,
        })
      ).status,
      200,
    );
    const page = await queue(f);
    assert.equal(page.body.items[0].bindingCurrent, false);
    assert.equal((await review(f, version)).body.error, "VERSION_BINDING_CHANGED");
    assert.equal((await queue(f, "", "user:bob")).status, 404);
    assert.equal(
      (await f.request("DELETE", `/v1/resources/${version.resourceId}`, { revision: 2 })).status,
      200,
    );
    assert.deepEqual((await queue(f)).body.items, []);
  } finally {
    await f.dispose();
  }
});

test("审核队列验证分页与路由，配置缺失、名单撤销及 D1 故障均失败关闭", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    for (const query of [
      "?limit=0",
      "?limit=51",
      "?after=x",
      "?limit=1&limit=2",
      "?owner=user:bob",
    ])
      assert.equal((await queue(f, query)).status, 400);
    for (const [method, route] of [
      ["POST", "/v1/reviews"],
      ["GET", "/v1/reviews/anything"],
    ])
      assert.equal(
        (await f.request(method, route, undefined, { principal: "user:reviewer" })).status,
        404,
      );
    const { version } = await readyVersion(f);
    for (const config of [undefined, "[]", "invalid"])
      assert.equal(
        (await callWithEnv(f, "GET", "/v1/reviews", undefined, { REVIEWER_PRINCIPALS: config }))
          .status,
        503,
      );
    const revoked = await callWithEnv(f, "GET", `/v1/reviews?after=${version.id}`, undefined, {
      REVIEWER_PRINCIPALS: '["user:reviewer2"]',
    });
    assert.deepEqual(revoked, { status: 404, body: { error: "NOT_FOUND" } });
    const unavailable = await callWithEnv(f, "GET", "/v1/reviews", undefined, {
      DB: {
        prepare() {
          throw new Error("private database error");
        },
      },
    });
    assert.deepEqual(unavailable, { status: 503, body: { error: "SERVICE_UNAVAILABLE" } });
    const plan = await f.db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT id FROM versions WHERE state = 'pending_review' AND id > ? ORDER BY id LIMIT 21",
      )
      .bind("")
      .all();
    assert.match(JSON.stringify(plan.results), /versions_review_page/);
  } finally {
    await f.dispose();
  }
});
