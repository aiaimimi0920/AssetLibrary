import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { base64url, SignJWT } from "jose";
import { fixture } from "./fixture.mjs";
import {
  identityConfig,
  identityData,
  identityResult,
  identitySigner,
} from "./identity-fixture.mjs";

let f;
let signers;
before(async () => {
  signers = await Promise.all(
    ["one", "two", "three", "four"].map((kid, index) =>
      identitySigner(kid, index === 3 ? 4096 : 2048),
    ),
  );
  f = await fixture();
});
after(async () => f?.dispose());
const me = (token) => f.request("GET", "/v1/me", undefined, { token });

test("固定 JWKS 上限四把有效公钥，每把都可按 kid 验证且不持有客户端身份", async () => {
  await f.configureIdentity(identityConfig(signers.map((signer) => signer.jwk)));
  for (const signer of signers) {
    const result = await me(await signer.token());
    identityResult(result, 200);
    assert.deepEqual(result.body, { principal: "user:alice" });
  }
  identityResult(await me(null), 401);
  const now = Math.floor(Date.now() / 1000);
  const hmac = await new SignJWT({ sub: "user:alice", iat: now, exp: now + 300 })
    .setProtectedHeader({ alg: "HS256", kid: "one" })
    .sign(new Uint8Array(32).fill(7));
  identityResult(await me(hmac), 401);
  identityResult(await me("a".repeat(8193)), 401);
});

test("所有非法公钥配置均为脱敏 503，不因存在有效备用 key 而降级放行", async () => {
  const [first, second] = signers.map((signer) => signer.jwk);
  const token = await signers[0].token();
  const baseline = await identityData(f);
  const { kid: _kid, ...missingKid } = second;
  const config = identityConfig([first]);
  const narrow = base64url.decode(second.n);
  narrow[0] >>= 1;
  const even = base64url.decode(second.n);
  even[even.length - 1] &= 254;
  const invalidKeys = [
    null,
    [],
    "key",
    {},
    missingKid,
    { ...second, kid: "" },
    { ...second, kid: "x".repeat(129) },
    { ...second, kid: "含空格 kid" },
    { ...second, kty: "EC" },
    { ...second, alg: "PS256" },
    { ...second, use: "enc" },
    { ...second, key_ops: ["sign"] },
    { ...second, key_ops: ["verify", "verify"] },
    { ...second, key_ops: "verify" },
    { ...second, d: "TEST_PRIVATE_FIELD_DO_NOT_LOG" },
    { ...second, p: "TEST_PRIVATE_FIELD_DO_NOT_LOG" },
    { ...second, x5c: ["certificate"] },
    { ...second, jku: "https://untrusted.test" },
    { ...second, n: "AQAB" },
    { ...second, n: base64url.encode(narrow) },
    { ...second, n: base64url.encode(even) },
    { ...second, n: "_".repeat(684) },
    { ...second, n: `${second.n}=` },
    { ...second, e: "Ag" },
    { ...second, e: "AQ" },
    { ...second, e: "AAEAAQ" },
    { ...second, e: "AQABAAE" },
  ];
  const invalidSets = [
    null,
    [],
    { keys: [] },
    { keys: "not-an-array" },
    { keys: [first], unexpected: true },
    { keys: [first, { ...second, kid: first.kid }] },
    { keys: [first, { ...first, kid: "same-material" }] },
    { keys: [...signers.map((signer) => signer.jwk), { ...first, kid: "five" }] },
    ...invalidKeys.map((key) => ({ keys: [first, key] })),
  ];
  for (const value of invalidSets) {
    await f.configureIdentity({ ...config, AUTH_PUBLIC_JWKS: JSON.stringify(value) });
    identityResult(await me(token), 503);
    identityResult(await me(null), 503);
  }
  for (const changes of [
    { AUTH_PUBLIC_JWKS: "{" },
    { AUTH_PUBLIC_JWKS: " ".repeat(16385) },
    { AUTH_PUBLIC_JWK: JSON.stringify(first) },
    { AUTH_PUBLIC_JWK: "" },
    { AUTH_ISSUER: "" },
    { AUTH_AUDIENCE: "" },
  ]) {
    await f.configureIdentity({ ...config, ...changes });
    identityResult(await me(token), 503);
  }
  // 单钥同样拒绝私钥字段和越界配置，不回到旧的宽松导入路径。
  for (const encoded of [
    " ".repeat(4097),
    "null",
    JSON.stringify({ ...first, qi: "TEST_PRIVATE_FIELD_DO_NOT_LOG" }),
  ]) {
    await f.configureIdentity({ ...identityConfig([first], true), AUTH_PUBLIC_JWK: encoded });
    identityResult(await me(token), 503);
  }
  assert.deepEqual(await identityData(f), baseline);
  await f.configureIdentity(config);
  identityResult(await me(token), 200);
});
