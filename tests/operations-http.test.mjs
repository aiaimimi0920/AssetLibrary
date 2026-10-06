import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createResource, fixture } from "./fixture.mjs";
import { identityData } from "./identity-fixture.mjs";
import { captured, faultDatabase, hostFetch, OperationLog } from "./operations-fixture.mjs";
import { storageOverride } from "./upload-fixture.mjs";

let f;
const log = new OperationLog();
before(async () => {
  f = await fixture({ runtimeLog: log });
});
after(async () => f?.dispose());
const ready = {
  service: "assetlibrary",
  scope: "private_dependencies",
  status: "ready",
  checks: { identity: "available", database: "available", storage: "available" },
  distribution: { status: "blocked", reason: "SCANNER_CLOUD_NOT_VALIDATED" },
};

test("真实 Worker/D1/R2：只读依赖就绪不等于生产分发，存活与方法边界分开", async () => {
  const baseline = await identityData(f);
  const response = await f.request("GET", "/readyz", undefined, { token: null });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, ready);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(response.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
  assert.equal((await f.request("GET", "/healthz", undefined, { token: null })).status, 200);
  assert.equal((await f.request("POST", "/readyz", {}, { token: null })).status, 401);
  const catalog = await f.request("GET", "/v1/catalog", undefined, { token: null });
  assert.equal(catalog.status, 503);
  assert.deepEqual(catalog.body, { error: "SCANNER_CLOUD_NOT_VALIDATED" });
  assert.deepEqual(await identityData(f), baseline);
  assert.deepEqual((await f.bucket.list()).objects, []);
});

test("缺身份/缺 Schema 的降级可区分，身份恢复不重建业务状态", async () => {
  const resource = await createResource(f);
  const original = {
    AUTH_PUBLIC_JWK: f.env.AUTH_PUBLIC_JWK,
    AUTH_ISSUER: f.env.AUTH_ISSUER,
    AUTH_AUDIENCE: f.env.AUTH_AUDIENCE,
  };
  const baseline = await identityData(f);
  try {
    await f.configureIdentity({});
    const degraded = await f.request("GET", "/readyz", undefined, { token: null });
    assert.equal(degraded.status, 503);
    assert.equal(degraded.body.checks.identity, "unavailable");
    assert.equal(degraded.body.checks.database, "available");
    assert.equal((await f.request("GET", "/healthz", undefined, { token: null })).status, 200);
  } finally {
    await f.configureIdentity(original);
  }
  assert.deepEqual((await f.request("GET", "/readyz", undefined, { token: null })).body, ready);
  assert.equal((await f.request("GET", `/v1/resources/${resource.id}`)).status, 200);
  assert.deepEqual(await identityData(f), baseline);
  const noSchema = await fixture({ schema: false });
  try {
    const degraded = await noSchema.request("GET", "/readyz", undefined, { token: null });
    assert.equal(degraded.status, 503);
    assert.equal(degraded.body.checks.database, "unavailable");
    assert.equal(degraded.body.checks.identity, "available");
    assert.equal(degraded.body.checks.storage, "available");
  } finally {
    await noSchema.dispose();
  }
});

test("实际 Worker 响应事件可关联，但不复制客户端请求 ID、JWT、主体、路径或查询", async () => {
  const principal = "user:PRIVATE_PRINCIPAL_DO_NOT_LOG";
  const resource = await createResource(f, { principal });
  const result = await f.request(
    "GET",
    `/v1/resources/${resource.id}?secret=PRIVATE_QUERY_DO_NOT_LOG`,
    undefined,
    {
      principal,
      headers: {
        "x-request-id": "PRIVATE_CLIENT_ID_DO_NOT_LOG",
        cookie: "PRIVATE_COOKIE_DO_NOT_LOG",
      },
    },
  );
  assert.equal(result.status, 200);
  const id = result.headers.get("x-request-id");
  const event = await log.response(id);
  assert.deepEqual(
    Object.keys(event).sort(),
    ["durationMs", "event", "format", "method", "requestId", "route", "service", "status"].sort(),
  );
  assert.equal(event.event, "http.response_ready");
  assert.equal(event.route, "resources");
  assert.equal(event.status, 200);
  assert.ok(Number.isSafeInteger(event.durationMs) && event.durationMs >= 0);
  assert.notEqual(id, "PRIVATE_CLIENT_ID_DO_NOT_LOG");
  assert.ok(!JSON.stringify(log.events).includes("PRIVATE_"));
  assert.ok(!JSON.stringify(log.events).includes(resource.id));
});

test("D1/R2 读故障返回脱敏降级，恢复后就绪；事件也不包含内部错误", async () => {
  for (const overrides of [
    { DB: faultDatabase(f.db, () => true, "PRIVATE_SQL_DO_NOT_LOG") },
    {
      QUARANTINE: storageOverride(f, {
        head: async () => {
          throw new Error("PRIVATE_R2_DO_NOT_LOG");
        },
      }),
    },
  ]) {
    const result = await captured(() => hostFetch(f, "/readyz", overrides));
    assert.equal(result.value.status, 503);
    const body = await result.value.json();
    assert.equal(body.status, "degraded");
    assert.ok(!JSON.stringify([body, result.events]).includes("PRIVATE_"));
  }
  const recovered = await captured(() => hostFetch(f, "/readyz"));
  assert.deepEqual(await recovered.value.json(), ready);
  const failed = await captured(async () =>
    hostFetch(
      f,
      "/v1/me/resources",
      {
        DB: faultDatabase(f.db, () => true, "PRIVATE_SQL_DO_NOT_LOG"),
      },
      { headers: { authorization: `Bearer ${await f.token()}` } },
    ),
  );
  assert.equal(failed.value.status, 503);
  assert.deepEqual(await failed.value.json(), { error: "SERVICE_UNAVAILABLE" });
  assert.ok(!JSON.stringify(failed.events).includes("PRIVATE_"));
});

test("日志 sink 失败不改变 HTTP 结果、缓存头或提交的幂等事实", async () => {
  const key = "operations-logger-create";
  const options = {
    method: "POST",
    headers: {
      authorization: `Bearer ${await f.token()}`,
      "content-type": "application/json",
      "idempotency-key": key,
    },
    body: JSON.stringify({ kind: "art", title: "日志失败仍可提交" }),
  };
  const first = await captured(() => hostFetch(f, "/v1/resources", {}, options), {
    brokenLogger: true,
  });
  assert.equal(first.value.status, 201);
  assert.equal(first.value.headers.get("cache-control"), "no-store");
  const resource = await first.value.json();
  const replay = await captured(() => hostFetch(f, "/v1/resources", {}, options));
  assert.equal(replay.value.status, 201);
  assert.deepEqual(await replay.value.json(), resource);
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM audit_events WHERE resource_id = ?")
        .bind(resource.id)
        .first()
    ).n,
    1,
  );
});
