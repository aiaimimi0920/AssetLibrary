import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { createResource, fixture } from "./fixture.mjs";
import {
  identityConfig,
  identityData,
  identityResult,
  identitySigner,
} from "./identity-fixture.mjs";

let f;
let oldKey;
let newKey;
let outsider;
before(async () => {
  [oldKey, newKey, outsider] = await Promise.all(
    ["old-key", "new-key", "outsider"].map((kid) => identitySigner(kid)),
  );
  f = await fixture();
});
after(async () => f?.dispose());

const me = (token) => f.request("GET", "/v1/me", undefined, { token });

test("真实 Worker/D1/R2：单钥、重叠、撤旧和回滚不改变主体、权限、幂等或审计", async () => {
  await f.configureIdentity(identityConfig([oldKey.jwk], true));
  const oldToken = await oldKey.token();
  const newToken = await newKey.token();
  const body = { kind: "art", title: "轮换前的资源" };
  const key = "rotation-create-0001";
  const created = await f.request("POST", "/v1/resources", body, { token: oldToken, key });
  assert.equal(created.status, 201);
  const resource = created.body;
  const endpoint = `/v1/resources/${resource.id}`;
  const grant = await f.request(
    "PUT",
    `${endpoint}/members/user:bob`,
    { revision: 1 },
    { token: oldToken },
  );
  assert.equal(grant.status, 200);
  const bytes = new TextEncoder().encode("与身份配置无关的隔离对象");
  await f.bucket.put("rotation-preserved-object", bytes);
  const baseline = await identityData(f);
  const etag = (await f.bucket.head("rotation-preserved-object")).etag;
  identityResult(await me(oldToken), 200);
  identityResult(await me(newToken), 401);

  await f.configureIdentity(identityConfig([oldKey.jwk, newKey.jwk]));
  for (const signer of [oldKey, newKey]) {
    const token = await signer.token();
    assert.deepEqual((await me(token)).body, { principal: "user:alice" });
    assert.deepEqual(
      (await f.request("POST", "/v1/resources", body, { token, key })).body,
      resource,
    );
    const current = await f.request("GET", endpoint, undefined, { token });
    assert.equal(current.status, 200);
    assert.equal(current.body.revision, 2);
    assert.equal(current.body.owner, resource.owner);
    const memberToken = await signer.token("user:bob");
    assert.equal((await f.request("GET", endpoint, undefined, { token: memberToken })).status, 200);
    assert.equal(
      (await f.request("PATCH", endpoint, { revision: 2, title: "越权" }, { token: memberToken }))
        .status,
      404,
    );
  }
  // 拒绝的业务操作可能保存独立幂等回执；旋转本身及成功重放不得改变已有事实。
  const overlap = await identityData(f);
  assert.deepEqual(overlap.resources, baseline.resources);
  assert.deepEqual(overlap.resource_members, baseline.resource_members);
  assert.deepEqual(overlap.audit_events, baseline.audit_events);
  assert.deepEqual(overlap.mutation_requests.slice(0, 2), baseline.mutation_requests);

  await f.configureIdentity(identityConfig([newKey.jwk]));
  identityResult(await me(oldToken), 401);
  identityResult(await me(newToken), 200);
  const deniedWrite = await f.request(
    "PATCH",
    endpoint,
    { revision: 2, title: "被撤旧钥不得写入" },
    { token: oldToken },
  );
  identityResult(deniedWrite, 401);
  const replay = await f.request("POST", "/v1/resources", body, { token: newToken, key });
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, resource);
  assert.deepEqual(await identityData(f), overlap);

  // 普通操作失误可恢复上个可信配置；泄露密钥不得按此路径重新启用。
  await f.configureIdentity(identityConfig([oldKey.jwk, newKey.jwk]));
  identityResult(await me(oldToken), 200);
  identityResult(await me(newToken), 200);
  assert.deepEqual(await identityData(f), overlap);
  assert.equal((await f.bucket.head("rotation-preserved-object")).etag, etag);
  assert.deepEqual(
    new Uint8Array(await (await f.bucket.get("rotation-preserved-object")).arrayBuffer()),
    bytes,
  );
  const revoked = await f.request(
    "DELETE",
    `${endpoint}/members/user:bob`,
    { revision: 2 },
    { token: newToken },
  );
  assert.equal(revoked.status, 200);
  assert.equal(revoked.body.revision, 3);
  for (const signer of [oldKey, newKey]) {
    const token = await signer.token("user:bob");
    assert.equal((await f.request("GET", endpoint, undefined, { token })).status, 404);
  }
});

test("单钥迁移窗口允许无 kid 令牌；进入 JWKS 后必须精确命中 kid，不回退猜钥", async () => {
  const { kid: _kid, ...unlabelled } = oldKey.jwk;
  const legacy = await oldKey.token("user:alice", {}, {});
  await f.configureIdentity(identityConfig([unlabelled], true));
  identityResult(await me(legacy), 200);
  identityResult(await me(await oldKey.token()), 401);
  await f.configureIdentity(identityConfig([oldKey.jwk], true));
  identityResult(await me(legacy), 200);
  identityResult(await me(await oldKey.token()), 200);
  identityResult(await me(await oldKey.token("user:alice", {}, { kid: "unknown" })), 401);
  await f.configureIdentity(identityConfig([oldKey.jwk, newKey.jwk]));
  for (const token of [
    legacy,
    await oldKey.token("user:alice", {}, { kid: "unknown" }),
    await oldKey.token("user:alice", {}, { kid: "new-key" }),
    await outsider.token(
      "user:alice",
      {},
      { kid: "old-key", jku: "https://untrusted.test/keys", jwk: outsider.jwk },
    ),
  ])
    identityResult(await me(token), 401);
  identityResult(await me(await newKey.token()), 200);
  for (const kid of [null, 7, [], {}]) {
    identityResult(await me(await oldKey.token("user:alice", {}, { kid })), 401);
  }
});

test("重叠公钥不会改变 15 分钟、issuer/audience/subject 和 nbf 合同", async () => {
  await f.configureIdentity(identityConfig([oldKey.jwk, newKey.jwk]));
  const now = Math.floor(Date.now() / 1000);
  for (const signer of [oldKey, newKey]) {
    for (const claims of [
      { exp: now - 1 },
      { exp: now + 901 },
      { iat: now - 901, exp: now + 1 },
      { exp: undefined },
      { iat: undefined },
      { iat: now + 60 },
      { exp: now },
      { nbf: now + 60 },
      { iss: "https://untrusted.test" },
      { aud: "another-service" },
      { sub: "" },
    ])
      identityResult(await me(await signer.token("user:alice", { iat: now, ...claims })), 401);
    identityResult(await me(await signer.token("user:alice", { iat: now, exp: now + 900 })), 200);
  }
});

test("身份配置缺失或损坏失败关闭，恢复后保留原资源并继续使用原幂等键", async () => {
  await f.configureIdentity(identityConfig([newKey.jwk]));
  const token = await newKey.token();
  const resource = await createResource(f, { token, key: "identity-recovery-create" });
  const baseline = await identityData(f);
  for (const config of [{}, { ...identityConfig([newKey.jwk]), AUTH_PUBLIC_JWKS: "broken" }]) {
    await f.configureIdentity(config);
    identityResult(await me(token), 503);
    identityResult(
      await f.request("POST", "/v1/resources", { kind: "art", title: "不能创建" }, { token }),
      503,
    );
    assert.equal((await f.request("GET", "/healthz", undefined, { token: null })).status, 200);
    assert.deepEqual(await identityData(f), baseline);
  }
  await f.configureIdentity(identityConfig([newKey.jwk]));
  const replay = await f.request(
    "POST",
    "/v1/resources",
    { kind: "art", title: "无害测试资源" },
    { token, key: "identity-recovery-create" },
  );
  assert.equal(replay.status, 201);
  assert.deepEqual(replay.body, resource);
  assert.deepEqual(await identityData(f), baseline);
});
