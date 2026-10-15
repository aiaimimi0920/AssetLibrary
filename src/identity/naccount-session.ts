import { HttpError } from "../http";
import {
  cookie,
  type NAccountEnv,
  naccountConfig,
  sameOrigin,
  sessionCookie,
} from "./naccount-config";
import { validateNAccountToken } from "./naccount-provider";
import { hash, unseal } from "./session-store";

export interface Session {
  session_hash: string;
  principal: string;
  access_token: string;
  csrf_hash: string;
  expires_at: number;
}
export async function sessionRecord(request: Request, env: NAccountEnv) {
  naccountConfig(env);
  const value = cookie(request, sessionCookie);
  if (!value) throw new HttpError(401, "UNAUTHENTICATED");
  const row = await env.DB.prepare(
    "SELECT * FROM auth_sessions WHERE session_hash = ? AND expires_at > ?",
  )
    .bind(await hash(value), Date.now())
    .first<Session>();
  if (!row) throw new HttpError(401, "UNAUTHENTICATED");
  return row;
}
export async function csrfCheck(request: Request, env: NAccountEnv, session: Session) {
  if (!["GET", "HEAD"].includes(request.method)) sameOrigin(request, env);
  const value = request.headers.get("X-AssetLibrary-CSRF") ?? "";
  if (!/^[0-9a-f]{64}$/.test(value) || (await hash(value)) !== session.csrf_hash)
    throw new HttpError(403, "AUTH_CSRF_REJECTED");
}
export async function naccountIdentity(request: Request, env: NAccountEnv, bindPage = true) {
  // 原生客户端使用独立登记的 azp；网页 cookie/CSRF 流程保持不变。
  const authorization = request.headers.get("Authorization");
  if (authorization !== null) {
    const clientId = env.NACCOUNT_NATIVE_CLIENT_ID;
    if (!clientId) throw new HttpError(401, "NATIVE_CLIENT_NOT_CONFIGURED");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(clientId) || clientId === env.NACCOUNT_CLIENT_ID)
      throw new HttpError(503, "IDENTITY_NOT_CONFIGURED");
    if (request.headers.has("Cookie") || !authorization.startsWith("Bearer "))
      throw new HttpError(401, "UNAUTHENTICATED");
    return (await validateNAccountToken(env, authorization.slice(7), clientId)).principal;
  }
  const session = await sessionRecord(request, env);
  if (bindPage) await csrfCheck(request, env, session);
  try {
    const token = await unseal(env, session.access_token, `session:${session.session_hash}`);
    const identity = await validateNAccountToken(env, token);
    if (identity.principal !== session.principal) throw new HttpError(401, "UNAUTHENTICATED");
    return identity.principal;
  } catch (error) {
    if (error instanceof HttpError && error.status === 401)
      await env.DB.prepare("DELETE FROM auth_sessions WHERE session_hash = ?")
        .bind(session.session_hash)
        .run();
    throw error;
  }
}
