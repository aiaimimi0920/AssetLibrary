import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { fixture } from "./fixture.mjs";
import { hostWorker } from "./worker-fixture.mjs";

export async function naccountFixture() {
  const f = await fixture();
  const worker = await hostWorker();
  const issuer = `https://${crypto.randomUUID()}.naccount.test`;
  const origin = "https://assetlibrary.test";
  const env = {
    ...f.env,
    NACCOUNT_ISSUER: issuer,
    APP_ORIGIN: origin,
    NACCOUNT_CLIENT_ID: "assetlibrary-client",
    NACCOUNT_SESSION_KEY: "a".repeat(64),
  };
  let { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  let jwk = { ...(await exportJWK(publicKey)), kid: "naccount-test", alg: "RS256", use: "sig" };
  const claims = {
    sub: "naccount-user-1",
    azp: env.NACCOUNT_CLIENT_ID,
    tokenType: "user",
    scope: "openid profile",
    securityVersion: 0,
  };
  const remote = {
    active: true,
    available: true,
    calls: [],
    claims,
    authId: "naccount-user-1",
    token: "",
    verifier: "",
  };
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options = {}) => {
    remote.calls.push(String(url));
    assert.equal(options.redirect, "manual");
    if (!remote.available) return new Response(null, { status: 503 });
    if (url === `${issuer}/.well-known/jwks.json`) {
      await remote.keysGate?.();
      return remote.keysFail ? new Response(null, { status: 503 }) : Response.json({ keys: [jwk] });
    }
    if (url === `${issuer}/oauth2/v1/token`) {
      await remote.tokenGate?.();
      const body = new URLSearchParams(options.body);
      assert.equal(body.get("grant_type"), "authorization_code");
      remote.verifier = body.get("code_verifier");
      const now = Math.floor(Date.now() / 1000);
      remote.token = await new SignJWT({ ...claims, iss: issuer, iat: now, exp: now + 600 })
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .sign(privateKey);
      return Response.json({ access_token: remote.token, token_type: "Bearer" });
    }
    if (url === `${issuer}/oauth2/v1/userinfo`)
      return remote.active
        ? Response.json({ authId: remote.authId, email: "not-a-principal@example.test" })
        : new Response(null, { status: 401 });
    throw new Error("UNEXPECTED_PROVIDER_REQUEST");
  };
  async function request(path, { method = "GET", cookie, csrf, headers = {}, body } = {}) {
    const requestHeaders = new Headers({
      ...(method !== "GET" ? { Origin: origin } : {}),
      ...(cookie ? { Cookie: cookie } : {}),
      ...(csrf ? { "X-AssetLibrary-CSRF": csrf } : {}),
    });
    for (const [name, value] of Object.entries(headers)) {
      if (value === null) requestHeaders.delete(name);
      else requestHeaders.set(name, value);
    }
    return worker.fetch(
      new Request(`${origin}${path}`, {
        method,
        headers: requestHeaders,
        ...(body ? { body } : {}),
      }),
      env,
    );
  }
  async function start(path = "/auth/login") {
    const response = await request(path, { method: "POST" });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const url = new URL(response.headers.get("location"));
    const flowCookie = response.headers.get("set-cookie").split(";")[0];
    return {
      url,
      flowCookie,
      path: `/auth/callback?state=${url.searchParams.get("state")}&code=single-code`,
    };
  }
  async function login() {
    const flow = await start();
    const response = await request(flow.path, { cookie: flow.flowCookie });
    assert.equal(response.headers.get("location"), origin);
    assert.equal(response.headers.get("referrer-policy"), "no-referrer");
    const cookie = response.headers
      .getSetCookie()
      .find((v) => v.startsWith("__Host-assetlibrary-session="))
      .split(";")[0];
    assert.equal(
      createHash("sha256").update(remote.verifier).digest("base64url"),
      flow.url.searchParams.get("code_challenge"),
    );
    const session = await (await request("/auth/session", { cookie })).json();
    return { ...flow, cookie, csrf: session.csrf, principal: session.principal };
  }
  return {
    ...f,
    env,
    remote,
    request,
    start,
    login,
    rotateKey: async () => {
      ({ publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true }));
      jwk = { ...(await exportJWK(publicKey)), kid: crypto.randomUUID(), alg: "RS256", use: "sig" };
    },
    issueToken: async (overrides = {}) => {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ ...claims, iss: issuer, iat: now, exp: now + 600, ...overrides })
        .setProtectedHeader({ alg: "RS256", kid: jwk.kid })
        .sign(privateKey);
    },
    dispose: async () => {
      globalThis.fetch = originalFetch;
      await f.dispose();
    },
  };
}
