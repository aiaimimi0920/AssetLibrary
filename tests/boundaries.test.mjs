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

test("外部签名身份：缺失、伪造、过期、错误 issuer/audience/subject 均拒绝", async () => {
  assert.equal(
    (
      await f.request("GET", "/v1/me/resources", undefined, {
        token: null,
        headers: { "x-principal-ref": "user:alice" },
      })
    ).status,
    401,
  );
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [
    { exp: now - 1 },
    { iss: "https://attacker.test" },
    { aud: "another-service" },
    { iat: now + 60 },
    { sub: "" },
    { exp: now + 3600 },
    { exp: undefined },
    { iat: undefined },
    { nbf: now + 60 },
  ]) {
    const token = await f.token("user:alice", claims);
    assert.equal((await f.request("GET", "/v1/me/resources", undefined, { token })).status, 401);
  }
  const token = await f.token();
  const [header, payload, signature] = token.split(".");
  const badSignature = `${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`;
  for (const badToken of [
    "garbage",
    `${header}.${payload}.${badSignature}`,
    `eyJhbGciOiJub25lIn0.${payload}.`,
  ]) {
    const result = await f.request("GET", "/v1/me/resources", undefined, { token: badToken });
    assert.equal(result.status, 401);
    assert.deepEqual(result.body, { error: "UNAUTHENTICATED" });
    assert.equal(result.headers.get("cache-control"), "no-store");
  }
});

test("输入有界、未知字段失败关闭、不信任客户端 owner/state/revision", async () => {
  for (const body of [
    { kind: "art", title: "x", owner: "user:eve" },
    { kind: "art", title: "x", state: "published" },
    { kind: "art", title: "" },
    { kind: "art", title: "x".repeat(201) },
    { kind: "art", title: "bad\u0000name" },
    { kind: "unknown", title: "x" },
    { kind: "art", title: 123 },
    [],
    null,
  ])
    assert.equal((await f.request("POST", "/v1/resources", body)).status, 400);
  assert.equal((await f.request("POST", "/v1/resources", { title: "x".repeat(9000) })).status, 413);
  assert.equal(
    (await f.request("POST", "/v1/resources", { kind: "art", title: "x" }, { key: "short" }))
      .status,
    400,
  );
  assert.equal(
    (
      await f.request(
        "POST",
        "/v1/resources",
        { kind: "art", title: "x" },
        { headers: { "content-type": "text/plain" } },
      )
    ).status,
    415,
  );
  const resource = await createResource(f);
  const endpoint = `/v1/resources/${resource.id}`;
  for (const revision of [0, -1, 1.5, "1", 2147483647]) {
    assert.equal((await f.request("DELETE", endpoint, { revision })).status, 400);
  }
  assert.equal(
    (await f.request("PUT", `${endpoint}/members/user:alice`, { revision: 1 })).status,
    400,
  );
  assert.equal((await f.request("PUT", `${endpoint}/members/%ZZ`, { revision: 1 })).status, 400);
  const sqlText = "'; DROP TABLE resources; --";
  const updated = await f.request("PATCH", endpoint, { title: sqlText, revision: 1 });
  assert.equal(updated.status, 200);
  assert.equal((await f.request("GET", endpoint)).body.title, sqlText);
});

test("缺少身份配置不能启用开发旁路", async () => {
  const isolated = await fixture({ identity: false });
  try {
    const result = await isolated.request("GET", "/v1/me/resources");
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "IDENTITY_NOT_CONFIGURED" });
    assert.equal(
      (await isolated.request("GET", "/healthz", undefined, { token: null })).status,
      200,
    );
  } finally {
    await isolated.dispose();
  }
});

test("缺少 D1 Schema 的真实数据库失败返回脱敏 503", async () => {
  const isolated = await fixture({ schema: false });
  try {
    for (const [method, route, body] of [
      ["GET", "/v1/me/resources", undefined],
      ["POST", "/v1/resources", { kind: "art", title: "不能假成功" }],
    ]) {
      const result = await isolated.request(method, route, body);
      assert.equal(result.status, 503);
      assert.deepEqual(result.body, { error: "SERVICE_UNAVAILABLE" });
    }
  } finally {
    await isolated.dispose();
  }
});
