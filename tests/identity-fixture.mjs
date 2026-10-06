import assert from "node:assert/strict";
import { exportJWK, generateKeyPair, SignJWT } from "jose";

/** 私钥只活在本次测试进程的闭包内；不落盘，不加入 Worker 或交付包。 */
export async function identitySigner(kid, modulusLength = 2048) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", {
    extractable: true,
    modulusLength,
  });
  const jwk = {
    ...(await exportJWK(publicKey)),
    kid,
    alg: "RS256",
    use: "sig",
    key_ops: ["verify"],
  };
  async function token(principal = "user:alice", claims = {}, header = { kid }) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
      sub: principal,
      iat: now,
      exp: now + 300,
      iss: "https://identity.test",
      aud: "assetlibrary-test",
      ...claims,
    })
      .setProtectedHeader({ alg: "RS256", ...header })
      .sign(privateKey);
  }
  return { jwk, token };
}

export function identityConfig(keys, single = false) {
  return {
    [single ? "AUTH_PUBLIC_JWK" : "AUTH_PUBLIC_JWKS"]: JSON.stringify(single ? keys[0] : { keys }),
    AUTH_ISSUER: "https://identity.test",
    AUTH_AUDIENCE: "assetlibrary-test",
  };
}

export function identityResult(result, status) {
  assert.equal(result.status, status);
  assert.equal(result.headers.get("cache-control"), "no-store");
  if (status !== 200)
    assert.deepEqual(result.body, {
      error: status === 503 ? "IDENTITY_NOT_CONFIGURED" : "UNAUTHENTICATED",
    });
}

export async function identityData(f) {
  const state = {};
  for (const table of ["resources", "resource_members", "mutation_requests", "audit_events"]) {
    state[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results;
  }
  return state;
}
