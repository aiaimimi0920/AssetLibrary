import assert from "node:assert/strict";
import test from "node:test";
import { createResource, fixture } from "./fixture.mjs";

test("owner 查询指定目录读权限及同一资源 revision，查询本身不改变审计和权限", async () => {
  const f = await fixture();
  try {
    const resource = await createResource(f);
    const path = `/v1/resources/${resource.id}/members/user:bob`;
    const initial = await f.request("GET", path);
    assert.equal(initial.status, 200);
    assert.deepEqual(initial.body, {
      resourceId: resource.id,
      principal: "user:bob",
      active: false,
      resourceRevision: 1,
    });
    assert.equal(initial.headers.get("cache-control"), "no-store");
    assert.equal(
      (await f.request("PUT", path, { revision: initial.body.resourceRevision })).status,
      200,
    );
    const granted = await f.request("GET", path);
    assert.equal(granted.body.active, true);
    assert.equal(granted.body.resourceRevision, 2);
    assert.equal(
      (await f.request("DELETE", path, { revision: granted.body.resourceRevision })).status,
      200,
    );
    const revoked = await f.request("GET", path);
    assert.equal(revoked.body.active, false);
    assert.equal(revoked.body.resourceRevision, 3);
    const audits = await f.db
      .prepare("SELECT action FROM audit_events WHERE resource_id = ? ORDER BY revision")
      .bind(resource.id)
      .all();
    assert.deepEqual(
      audits.results.map((row) => row.action),
      ["create", "grant", "revoke"],
    );
  } finally {
    await f.dispose();
  }
});

test("目录成员和无关主体无权查看权限管理事实，错误输入及已关闭资源拒绝", async () => {
  const f = await fixture();
  try {
    const resource = await createResource(f);
    const base = `/v1/resources/${resource.id}`;
    await f.request("PUT", `${base}/members/user:bob`, { revision: 1 });
    for (const principal of ["user:bob", "user:eve"])
      assert.equal(
        (await f.request("GET", `${base}/members/user:other`, undefined, { principal })).status,
        404,
      );
    for (const suffix of ["user:alice", "%zz", "user%2Fbad", "user:bob?unexpected=1"])
      assert.equal((await f.request("GET", `${base}/members/${suffix}`)).status, 400);
    assert.equal(
      (await f.request("GET", `${base}/members/user:bob`, undefined, { token: null })).status,
      401,
    );
    await f.request("DELETE", base, { revision: 2 });
    assert.equal((await f.request("GET", `${base}/members/user:bob`)).status, 404);
  } finally {
    await f.dispose();
  }
});

test("目录查询不是后续授权凭据，期间资源改变使旧 revision 写入失败", async () => {
  const f = await fixture();
  try {
    const resource = await createResource(f);
    const base = `/v1/resources/${resource.id}`;
    const member = (await f.request("GET", `${base}/members/user:bob`)).body;
    await f.request("PATCH", base, { title: "并发更名", revision: 1 });
    const stale = await f.request("PUT", `${base}/members/user:bob`, {
      revision: member.resourceRevision,
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.error, "REVISION_CONFLICT");
    assert.deepEqual((await f.request("GET", `${base}/members/user:bob`)).body, {
      ...member,
      active: false,
      resourceRevision: 2,
    });
  } finally {
    await f.dispose();
  }
});
