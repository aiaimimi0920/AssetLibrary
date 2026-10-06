import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createResource, fixture } from "./fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});

test("真实 Worker/D1：创建、查询、修改、关联、解除、删除闭环", async () => {
  const resource = await createResource(f);
  const endpoint = `/v1/resources/${resource.id}`;
  assert.equal(resource.state, "draft");
  assert.equal(resource.revision, 1);
  assert.equal(resource.owner, "user:alice");
  assert.equal((await f.request("GET", endpoint)).body.title, "无害测试资源");
  let result = await f.request("PATCH", endpoint, { title: "新版目录", revision: 1 });
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 2);
  result = await f.request("PUT", `${endpoint}/members/user:bob`, { revision: 2 });
  assert.equal(result.status, 200);
  assert.equal(result.body.revision, 3);
  assert.equal(
    (await f.request("GET", endpoint, undefined, { principal: "user:bob" })).status,
    200,
  );
  const library = await f.request("GET", "/v1/me/resources", undefined, { principal: "user:bob" });
  assert.deepEqual(
    library.body.items.map((r) => r.id),
    [resource.id],
  );
  result = await f.request("DELETE", `${endpoint}/members/user:bob`, { revision: 3 });
  assert.equal(result.body.revision, 4);
  assert.equal(
    (await f.request("GET", endpoint, undefined, { principal: "user:bob" })).status,
    404,
  );
  assert.deepEqual(
    (await f.request("GET", "/v1/me/resources", undefined, { principal: "user:bob" })).body.items,
    [],
  );
  result = await f.request("DELETE", endpoint, { revision: 4 });
  assert.equal(result.status, 200);
  assert.equal(result.body.state, "deleted");
  assert.equal((await f.request("GET", endpoint)).status, 404);
  assert.equal(
    (await f.request("PATCH", endpoint, { title: "不能复活", revision: 5 })).status,
    404,
  );
  const audits = await f.db
    .prepare("SELECT action, revision FROM audit_events WHERE resource_id = ? ORDER BY revision")
    .bind(resource.id)
    .all();
  assert.deepEqual(
    audits.results.map((row) => row.action),
    ["create", "update", "grant", "revoke", "delete"],
  );
  assert.deepEqual(
    audits.results.map((row) => row.revision),
    [1, 2, 3, 4, 5],
  );
});

test("成员和无关主体不能写、授权或发现私有资源", async () => {
  const resource = await createResource(f);
  const endpoint = `/v1/resources/${resource.id}`;
  assert.equal(
    (await f.request("GET", endpoint, undefined, { principal: "user:eve" })).status,
    404,
  );
  assert.deepEqual(
    (await f.request("GET", "/v1/me/resources", undefined, { principal: "user:eve" })).body.items,
    [],
  );
  await f.request("PUT", `${endpoint}/members/user:bob`, { revision: 1 });
  for (const principal of ["user:bob", "user:eve"]) {
    for (const [method, route, body] of [
      ["PATCH", endpoint, { title: "被篡改", revision: 2 }],
      ["DELETE", endpoint, { revision: 2 }],
      ["PUT", `${endpoint}/members/user:eve`, { revision: 2 }],
    ]) {
      // 不使用自身成员目标，另由边界用例验证 owner-only 自身保护。
      const target = route.endsWith("user:eve") ? `${endpoint}/members/user:other` : route;
      assert.equal((await f.request(method, target, body, { principal })).status, 404);
    }
  }
  assert.equal((await f.request("GET", endpoint)).body.revision, 2);
  assert.equal((await f.request("POST", `${endpoint}/publish`, {})).status, 404);
  assert.equal((await f.request("GET", `${endpoint}/download`)).status, 404);
});

test("有界 keyset 分页稳定、无重复且不会夹入其他主体资源", async () => {
  const principal = "user:pager";
  const ids = [];
  for (let i = 0; i < 5; i++) ids.push((await createResource(f, { principal })).id);
  let cursor = "";
  const actual = [];
  do {
    const page = await f.request(
      "GET",
      `/v1/me/resources?limit=2${cursor ? `&after=${cursor}` : ""}`,
      undefined,
      { principal },
    );
    assert.equal(page.status, 200);
    assert.ok(page.body.items.length <= 2);
    actual.push(...page.body.items.map((r) => r.id));
    cursor = page.body.nextCursor;
  } while (cursor);
  assert.deepEqual(actual, ids.sort());
  for (const query of ["limit=0", "limit=51", "limit=1e1", "after=bad", "owner=user:alice"]) {
    assert.equal((await f.request("GET", `/v1/me/resources?${query}`)).status, 400);
  }
});
