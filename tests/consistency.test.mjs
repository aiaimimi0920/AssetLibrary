import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { createResource, fixture } from "./fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});

test("同主体并发重放只创建一次、审计一次；键内容冲突 409", async () => {
  const key = randomUUID();
  const body = { kind: "capability", title: "幂等资源" };
  const results = await Promise.all(
    Array.from({ length: 8 }, () => f.request("POST", "/v1/resources", body, { key })),
  );
  assert.ok(results.every((r) => r.status === 201));
  assert.ok(results.every((r) => JSON.stringify(r.body) === JSON.stringify(results[0].body)));
  const id = results[0].body.id;
  const count = await f.db
    .prepare("SELECT count(*) AS n FROM audit_events WHERE resource_id = ?")
    .bind(id)
    .first();
  assert.equal(count.n, 1);
  assert.equal(
    (await f.request("POST", "/v1/resources", { ...body, title: "不同内容" }, { key })).body.error,
    "IDEMPOTENCY_CONFLICT",
  );
  const other = await f.request("POST", "/v1/resources", body, { key, principal: "user:bob" });
  assert.equal(other.status, 201);
  assert.notEqual(other.body.id, id);
  const patch = await f.request("PATCH", `/v1/resources/${id}`, { revision: 1, title: "后来修改" });
  assert.equal(patch.status, 200);
  assert.deepEqual((await f.request("POST", "/v1/resources", body, { key })).body, results[0].body);
});

test("相同 revision 并发修改恰有一个成功，失败不写审计", async () => {
  const resource = await createResource(f);
  const results = await Promise.all(
    ["一", "二"].map((title) =>
      f.request("PATCH", `/v1/resources/${resource.id}`, { title, revision: 1 }),
    ),
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const current = await f.request("GET", `/v1/resources/${resource.id}`);
  assert.equal(current.body.revision, 2);
  const count = await f.db
    .prepare("SELECT count(*) AS n FROM audit_events WHERE resource_id = ?")
    .bind(resource.id)
    .first();
  assert.equal(count.n, 2);
});

test("删除与授权竞争不会产生墓碑后成员或幽灵审计", async () => {
  const resource = await createResource(f);
  const endpoint = `/v1/resources/${resource.id}`;
  const results = await Promise.all([
    f.request("DELETE", endpoint, { revision: 1 }),
    f.request("PUT", `${endpoint}/members/user:bob`, { revision: 1 }),
  ]);
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.ok(results.filter((r) => r.status !== 200).every((r) => [404, 409].includes(r.status)));
  const row = await f.db
    .prepare("SELECT state, revision FROM resources WHERE id = ?")
    .bind(resource.id)
    .first();
  assert.equal(row.revision, 2);
  const count = await f.db
    .prepare("SELECT count(*) AS n FROM resource_members WHERE resource_id = ?")
    .bind(resource.id)
    .first();
  assert.equal(count.n, row.state === "deleted" ? 0 : 1);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM audit_events WHERE resource_id = ?")
        .bind(resource.id)
        .first()
    ).n,
    2,
  );
});

test("事务末尾故障回滚业务、幂等和审计；原键恢复后可安全重试", async () => {
  const resource = await createResource(f);
  const key = randomUUID();
  // 在最后的审计语句注入真实 SQLite 故障，不以 mock 代替原子回滚验证。
  await f.db
    .prepare(
      "CREATE TRIGGER reject_update BEFORE INSERT ON audit_events WHEN NEW.action = 'update' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_PRIVATE_ERROR'); END",
    )
    .run();
  try {
    const result = await f.request(
      "PATCH",
      `/v1/resources/${resource.id}`,
      { title: "不会落库", revision: 1 },
      { key },
    );
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "SERVICE_UNAVAILABLE" });
    assert.equal((await f.request("GET", `/v1/resources/${resource.id}`)).body.revision, 1);
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM mutation_requests WHERE request_key = ?")
          .bind(key)
          .first()
      ).n,
      0,
    );
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM audit_events WHERE resource_id = ?")
          .bind(resource.id)
          .first()
      ).n,
      1,
    );
  } finally {
    await f.db.prepare("DROP TRIGGER reject_update").run();
  }
  const retry = await f.request(
    "PATCH",
    `/v1/resources/${resource.id}`,
    { title: "不会落库", revision: 1 },
    { key },
  );
  assert.equal(retry.status, 200);
  assert.equal(retry.body.revision, 2);
});
