import { createLocalJWKSet, type JSONWebKeySet, jwtVerify } from "jose";
import { HttpError, principalRef } from "../http";
import { type NAccountEnv, naccountConfig } from "./naccount-config";

let keys:
  | {
      issuer: string;
      until: number;
      refreshAfter: number;
      resolve: ReturnType<typeof createLocalJWKSet>;
    }
  | undefined;
let loading: { issuer: string; promise: Promise<ReturnType<typeof createLocalJWKSet>> } | undefined;
let retryAfter: { issuer: string; at: number } | undefined;

/** 固定部署 issuer，不跟随重定向，不记录远端响应或令牌。 */
export async function providerJson(url: string, init: RequestInit = {}) {
  const response = await fetch(url, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new HttpError(
      response.status === 401 || response.status === 403 ? 401 : 503,
      "NACCOUNT_REQUEST_REJECTED",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) throw new HttpError(503, "NACCOUNT_RESPONSE_INVALID");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.length;
      if (size > 65536) throw new HttpError(503, "NACCOUNT_RESPONSE_INVALID");
      chunks.push(next.value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
}

async function verificationKeys(issuer: string, refresh = false) {
  // 已缓存的有效 key 不依赖其他请求触发的轮换刷新，远端故障不拖累正常验签。
  if (!refresh && keys?.issuer === issuer && keys.until > Date.now()) return keys.resolve;
  if (loading?.issuer === issuer) return loading.promise;
  if (
    keys?.issuer === issuer &&
    keys.until > Date.now() &&
    (!refresh || keys.refreshAfter > Date.now())
  )
    return keys.resolve;
  if (retryAfter?.issuer === issuer && retryAfter.at > Date.now())
    throw new HttpError(503, "NACCOUNT_KEYS_UNAVAILABLE");
  // 失败也消耗冷却预算；未知 kid 不能在远端故障时制造逐请求刷新。
  retryAfter = { issuer, at: Date.now() + 30000 };
  if (keys?.issuer === issuer) keys.refreshAfter = retryAfter.at;
  const current = {
    issuer,
    promise: Promise.resolve().then(async () => {
      const jwks = await providerJson(`${issuer}/.well-known/jwks.json`);
      if (
        !Array.isArray(jwks.keys) ||
        jwks.keys.length < 1 ||
        jwks.keys.length > 4 ||
        jwks.keys.some(
          (key: Record<string, unknown>) =>
            key.kty !== "RSA" || key.alg !== "RS256" || key.use !== "sig" || key.d !== undefined,
        )
      )
        throw new HttpError(503, "NACCOUNT_KEYS_INVALID");
      keys = {
        issuer,
        until: Date.now() + 300000,
        refreshAfter: Date.now() + 30000,
        resolve: createLocalJWKSet(jwks as JSONWebKeySet),
      };
      retryAfter = undefined;
      return keys.resolve;
    }),
  };
  loading = current;
  try {
    return await current.promise;
  } finally {
    if (loading === current) loading = undefined;
  }
}

export async function validateNAccountToken(
  env: NAccountEnv,
  token: string,
  nativeClientId?: string,
) {
  const { issuer, clientId: webClientId } = naccountConfig(env);
  const clientId = nativeClientId ?? webClientId;
  if (typeof token !== "string" || token.length > 8192) throw new HttpError(401, "UNAUTHENTICATED");
  const options = {
    issuer,
    algorithms: ["RS256"],
    requiredClaims: ["sub", "iat", "exp", "azp", "tokenType", "scope"],
  };
  let verified: Awaited<ReturnType<typeof jwtVerify>>;
  try {
    try {
      verified = await jwtVerify(token, await verificationKeys(issuer), options);
    } catch (error) {
      if ((error as { code?: string }).code !== "ERR_JWKS_NO_MATCHING_KEY") throw error;
      verified = await jwtVerify(token, await verificationKeys(issuer, true), options);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(401, "UNAUTHENTICATED");
  }
  const p = verified.payload;
  if (
    p.azp !== clientId ||
    p.tokenType !== "user" ||
    p.impersonatedBy !== undefined ||
    typeof p.scope !== "string" ||
    !p.scope.split(" ").includes("profile") ||
    !Number.isSafeInteger(p.iat) ||
    !Number.isSafeInteger(p.exp) ||
    (p.iat as number) > Math.floor(Date.now() / 1000) ||
    (p.exp as number) <= (p.iat as number)
  )
    throw new HttpError(401, "UNAUTHENTICATED");
  // 在线 userinfo 同时验证用户状态/securityVersion；离线签名不能冒充即时撤销检查。
  const user = await providerJson(`${issuer}/oauth2/v1/userinfo`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (user.authId !== p.sub) throw new HttpError(401, "UNAUTHENTICATED");
  return {
    principal: principalRef(p.sub),
    expiresAt: Math.min((p.exp as number) * 1000, Date.now() + 900000),
  };
}
