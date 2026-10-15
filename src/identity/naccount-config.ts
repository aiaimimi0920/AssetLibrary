import { HttpError } from "../http";

export interface NAccountEnv {
  DB: D1Database;
  NACCOUNT_ISSUER?: string;
  NACCOUNT_CLIENT_ID?: string;
  NACCOUNT_SESSION_KEY?: string;
  APP_ORIGIN?: string;
}

export function naccountConfig(env: NAccountEnv) {
  try {
    const issuer = new URL(env.NACCOUNT_ISSUER ?? "");
    const origin = new URL(env.APP_ORIGIN ?? "");
    if (
      issuer.protocol !== "https:" ||
      origin.protocol !== "https:" ||
      issuer.origin !== env.NACCOUNT_ISSUER ||
      origin.origin !== env.APP_ORIGIN ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(env.NACCOUNT_CLIENT_ID ?? "") ||
      !/^[0-9a-f]{64}$/.test(env.NACCOUNT_SESSION_KEY ?? "")
    )
      throw new Error();
    return {
      issuer: issuer.origin,
      origin: origin.origin,
      clientId: env.NACCOUNT_CLIENT_ID as string,
    };
  } catch {
    throw new HttpError(503, "IDENTITY_NOT_CONFIGURED");
  }
}

export function sameOrigin(request: Request, env: NAccountEnv) {
  if (request.headers.get("Origin") !== naccountConfig(env).origin)
    throw new HttpError(403, "AUTH_ORIGIN_REJECTED");
}

export const sessionCookie = "__Host-assetlibrary-session";
export const flowCookie = "__Host-assetlibrary-login";
export function cookie(request: Request, name: string) {
  const values = (request.headers.get("Cookie") ?? "")
    .split(";")
    .map((part) => part.trim())
    .filter((part) => part.startsWith(`${name}=`));
  const value = values.length === 1 ? (values[0] ?? "").slice(name.length + 1) : "";
  return /^[0-9a-f]{64}$/.test(value) ? value : "";
}
export function cookieHeader(name: string, value: string, seconds: number) {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${seconds}`;
}
