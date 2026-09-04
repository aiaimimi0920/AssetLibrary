import { afterEach, describe, expect, it, vi } from "vitest";
import {
  accountLoginUrl,
  exchangeAccountSession,
  parseAccountSession,
} from "./account-session";

vi.mock("server-only", () => ({}));

const validSession = {
  principal: { issuer: "https://accounts.neuro.example", subject: "account-42" },
  access_token: "publisher-access-token-that-is-long-enough",
  expires_at: "2099-09-03T08:00:00Z",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("external Account Service session adapter", () => {
  it("accepts only the exact, unexpired server session contract", () => {
    expect(parseAccountSession(validSession, Date.parse("2026-01-01T00:00:00Z"))).toEqual(validSession);
    expect(() => parseAccountSession({ ...validSession, password_hash: "forbidden" })).toThrow();
    expect(() => parseAccountSession({
      ...validSession,
      expires_at: "2025-01-01T00:00:00Z",
    }, Date.parse("2026-01-01T00:00:00Z"))).toThrow();
  });

  it("forwards only the configured cookie and refuses redirects or caching", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(validSession), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ASSETLIBRARY_ACCOUNT_SESSION_URL", "https://accounts.neuro.example/v1/session");
    vi.stubEnv("ASSETLIBRARY_ACCOUNT_SESSION_COOKIE", "neuro_session");

    await expect(exchangeAccountSession("opaque-session-value")).resolves.toEqual({
      ok: true,
      session: validSession,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      cache: "no-store",
      redirect: "error",
      headers: {
        accept: "application/json",
        cookie: "neuro_session=opaque-session-value",
      },
    });
  });

  it("fails closed for unsafe configuration and invalid responses", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...validSession, extra: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ASSETLIBRARY_ACCOUNT_SESSION_URL", "http://accounts.example/v1/session");
    await expect(exchangeAccountSession("opaque")).resolves.toEqual({ ok: false, failure: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();

    vi.stubEnv("ASSETLIBRARY_ACCOUNT_SESSION_URL", "http://127.0.0.1:4100/v1/session");
    await expect(exchangeAccountSession("opaque")).resolves.toEqual({ ok: false, failure: "invalid_response" });
  });

  it("only exposes a safe configured login URL", () => {
    vi.stubEnv("ASSETLIBRARY_ACCOUNT_LOGIN_URL", "https://accounts.neuro.example/login");
    expect(accountLoginUrl()).toBe("https://accounts.neuro.example/login");
    vi.stubEnv("ASSETLIBRARY_ACCOUNT_LOGIN_URL", "https://accounts.neuro.example/login#token");
    expect(accountLoginUrl()).toBeNull();
  });
});
