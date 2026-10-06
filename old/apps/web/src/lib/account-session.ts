import "server-only";

import { cookies } from "next/headers";
import type { PrincipalRef } from "./publisher-contracts";

const DEFAULT_COOKIE_NAME = "neuro_session";
const REQUEST_TIMEOUT_MS = 5_000;

export interface AccountSession {
  principal: PrincipalRef;
  access_token: string;
  expires_at: string;
}

export type AccountSessionResult =
  | { ok: true; session: AccountSession }
  | { ok: false; failure: "unauthenticated" | "not_configured" | "unavailable" | "invalid_response" };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function bounded(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseAccountSession(value: unknown, now = Date.now()): AccountSession {
  if (!isRecord(value)
    || !exactKeys(value, ["principal", "access_token", "expires_at"])
    || !isRecord(value.principal)
    || !exactKeys(value.principal, ["issuer", "subject"])
    || !bounded(value.principal.issuer, 200)
    || !bounded(value.principal.subject, 200)
    || !bounded(value.access_token, 8_192)
    || value.access_token.length < 32
    || !bounded(value.expires_at, 64)
    || !Number.isFinite(Date.parse(value.expires_at))
    || Date.parse(value.expires_at) <= now) {
    throw new Error("Invalid Account Service session contract");
  }
  return value as unknown as AccountSession;
}

function cookieName(): string | null {
  const value = process.env.ASSETLIBRARY_ACCOUNT_SESSION_COOKIE ?? DEFAULT_COOKIE_NAME;
  return /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : null;
}

function sessionEndpoint(): URL | null {
  const configured = process.env.ASSETLIBRARY_ACCOUNT_SESSION_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
      || url.username || url.password || url.hash) return null;
    return url;
  } catch {
    return null;
  }
}

function safeCookieValue(value: string): boolean {
  return value.length > 0
    && value.length <= 4_096
    && /^[\x21-\x3a\x3c-\x7e]+$/.test(value);
}

export async function exchangeAccountSession(sessionCookie: string | undefined): Promise<AccountSessionResult> {
  if (!sessionCookie) return { ok: false, failure: "unauthenticated" };
  const name = cookieName();
  const endpoint = sessionEndpoint();
  if (!name || !endpoint) return { ok: false, failure: "not_configured" };
  if (!safeCookieValue(sessionCookie)) return { ok: false, failure: "unauthenticated" };
  try {
    const response = await fetch(endpoint, {
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        cookie: `${name}=${sessionCookie}`,
      },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return { ok: false, failure: "unauthenticated" };
    }
    if (!response.ok) return { ok: false, failure: "unavailable" };
    try {
      return { ok: true, session: parseAccountSession(await response.json()) };
    } catch {
      return { ok: false, failure: "invalid_response" };
    }
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export async function currentAccountSession(): Promise<AccountSessionResult> {
  const name = cookieName();
  if (!name) return { ok: false, failure: "not_configured" };
  const store = await cookies();
  return exchangeAccountSession(store.get(name)?.value);
}

export function accountLoginUrl(): string | null {
  const configured = process.env.ASSETLIBRARY_ACCOUNT_LOGIN_URL;
  if (!configured) return null;
  try {
    const url = new URL(configured);
    const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    return (url.protocol === "https:" || url.protocol === "http:" && local)
      && !url.username && !url.password && !url.hash ? url.href : null;
  } catch {
    return null;
  }
}
