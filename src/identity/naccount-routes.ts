import { HttpError, json } from "../http";
import {
  cookie,
  cookieHeader,
  flowCookie,
  type NAccountEnv,
  naccountConfig,
  sameOrigin,
  sessionCookie,
} from "./naccount-config";
import { providerJson, validateNAccountToken } from "./naccount-provider";
import { csrfCheck, naccountIdentity, sessionRecord } from "./naccount-session";
import { expireAuth, hash, pkce, randomSecret, seal, unseal } from "./session-store";

function redirect(location: string, cookies: string[]) {
  const headers = new Headers({
    Location: location,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  for (const value of cookies) headers.append("Set-Cookie", value);
  return new Response(null, { status: 303, headers });
}

async function login(request: Request, env: NAccountEnv) {
  sameOrigin(request, env);
  const config = naccountConfig(env);
  await expireAuth(env.DB);
  const currentSession = cookie(request, sessionCookie);
  const browser = currentSession
    ? await hash(`login-browser:${currentSession}`)
    : cookie(request, flowCookie) || randomSecret();
  const state = randomSecret();
  const verifier = randomSecret();
  const stateHash = await hash(state);
  // 同一浏览器重新开始时废弃旧事务；全局未过期事务有硬上限。
  const old = cookie(request, flowCookie);
  if (old)
    await env.DB.prepare("DELETE FROM auth_transactions WHERE browser_hash = ?")
      .bind(await hash(old))
      .run();
  await env.DB.prepare("DELETE FROM auth_transactions WHERE browser_hash = ?")
    .bind(await hash(browser))
    .run();
  const inserted =
    await env.DB.prepare(`INSERT INTO auth_transactions(state_hash,browser_hash,verifier,expires_at)
    SELECT ?,?,?,? WHERE (SELECT count(*) FROM auth_transactions) < 1000`)
      .bind(
        stateHash,
        await hash(browser),
        await seal(env, verifier, `login:${stateHash}`),
        Date.now() + 300000,
      )
      .run();
  if (inserted.meta.changes !== 1) throw new HttpError(429, "LOGIN_CAPACITY_EXCEEDED");
  const url = new URL(`${config.issuer}/oauth2/v1/authorize`);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: `${config.origin}/auth/callback`,
    response_type: "code",
    scope: "openid profile",
    state,
    code_challenge: await pkce(verifier),
    code_challenge_method: "S256",
  }).toString();
  return redirect(url.href, [cookieHeader(flowCookie, browser, 300)]);
}

async function callback(request: Request, env: NAccountEnv) {
  const config = naccountConfig(env);
  const params = new URL(request.url).searchParams;
  const state = params.get("state") ?? "";
  const browser = cookie(request, flowCookie);
  if (!/^[0-9a-f]{64}$/.test(state) || !browser || params.getAll("state").length !== 1)
    throw new HttpError(400, "AUTH_CALLBACK_REJECTED");
  // 先原子认领，保留取消标记直到交换结束；退出能取消正在等待远端的登录。
  const stateHash = await hash(state);
  const flow = await env.DB.prepare(
    "UPDATE auth_transactions SET consumed = 1 WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? AND consumed = 0 RETURNING verifier",
  )
    .bind(stateHash, await hash(browser), Date.now())
    .first<{ verifier: string }>();
  if (!flow) throw new HttpError(400, "AUTH_CALLBACK_REJECTED");
  const clearFlow = cookieHeader(flowCookie, "", 0);
  try {
    const code = params.get("code");
    if (params.has("error") || !code || code.length > 4096 || params.getAll("code").length !== 1)
      throw new HttpError(400, "AUTH_CALLBACK_REJECTED");
    const result = await providerJson(`${config.issuer}/oauth2/v1/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        code_verifier: await unseal(env, flow.verifier, `login:${stateHash}`),
      }).toString(),
    });
    if (result.token_type !== "Bearer" || typeof result.access_token !== "string")
      throw new HttpError(401, "UNAUTHENTICATED");
    const identity = await validateNAccountToken(env, result.access_token);
    const session = randomSecret();
    const sessionHash = await hash(session);
    // CSRF 从秘密 cookie 派生，只通过同源 session JSON 返回，不暴露 cookie 本身。
    const csrf = await hash(`csrf:${session}`);
    const created = await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO auth_sessions(session_hash,principal,access_token,csrf_hash,browser_hash,expires_at) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM auth_transactions WHERE state_hash = ? AND consumed = 1 AND expires_at > ?)",
      ).bind(
        sessionHash,
        identity.principal,
        await seal(env, result.access_token, `session:${sessionHash}`),
        await hash(csrf),
        await hash(browser),
        identity.expiresAt,
        stateHash,
        Date.now(),
      ),
      env.DB.prepare("DELETE FROM auth_transactions WHERE browser_hash = ?").bind(
        await hash(browser),
      ),
    ]);
    if (created[0]?.meta.changes !== 1) throw new HttpError(400, "AUTH_CALLBACK_CANCELLED");
    const previous = cookie(request, sessionCookie);
    if (previous)
      await env.DB.prepare("DELETE FROM auth_sessions WHERE session_hash = ?")
        .bind(await hash(previous))
        .run();
    return redirect(config.origin, [
      clearFlow,
      cookieHeader(
        sessionCookie,
        session,
        Math.max(1, Math.floor((identity.expiresAt - Date.now()) / 1000)),
      ),
    ]);
  } catch {
    await env.DB.prepare("DELETE FROM auth_transactions WHERE state_hash = ?")
      .bind(stateHash)
      .run();
    return redirect(`${config.origin}/?auth=failed`, [clearFlow]);
  }
}

export async function authRoutes(request: Request, env: NAccountEnv): Promise<Response | null> {
  const url = new URL(request.url);
  if (!url.pathname.startsWith("/auth/")) return null;
  if (!env.NACCOUNT_ISSUER) {
    if (url.pathname === "/auth/session" && request.method === "GET")
      return json({ enabled: false });
    throw new HttpError(503, "IDENTITY_NOT_CONFIGURED");
  }
  const config = naccountConfig(env);
  if (url.origin !== config.origin) throw new HttpError(400, "AUTH_ORIGIN_REJECTED");
  if (url.pathname === "/auth/login" && request.method === "POST") return login(request, env);
  if (url.pathname === "/auth/callback" && request.method === "GET") return callback(request, env);
  if (url.pathname === "/auth/session" && request.method === "GET") {
    try {
      const principal = await naccountIdentity(request, env, false);
      return json({
        enabled: true,
        principal,
        csrf: await hash(`csrf:${cookie(request, sessionCookie)}`),
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 401)
        return json({ enabled: true, principal: null });
      throw error;
    }
  }
  if (url.pathname === "/auth/logout" && request.method === "POST") {
    const session = await sessionRecord(request, env);
    await csrfCheck(request, env, session);
    const browserHash = await hash(cookie(request, flowCookie));
    await env.DB.batch([
      env.DB.prepare("DELETE FROM auth_transactions WHERE browser_hash = ?").bind(browserHash),
      env.DB.prepare("DELETE FROM auth_sessions WHERE session_hash = ? OR browser_hash = ?").bind(
        session.session_hash,
        browserHash,
      ),
    ]);
    const logout = new URL(`${config.issuer}/oauth2/v1/logout`);
    logout.search = new URLSearchParams({
      client_id: config.clientId,
      post_logout_redirect_uri: config.origin,
    }).toString();
    const response = json({ logoutUrl: logout.href });
    response.headers.append("Set-Cookie", cookieHeader(sessionCookie, "", 0));
    response.headers.append("Set-Cookie", cookieHeader(flowCookie, "", 0));
    return response;
  }
  throw new HttpError(404, "NOT_FOUND");
}
