import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  currentAccountSession: vi.fn(),
  appeal: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/account-session", () => ({ currentAccountSession: mocks.currentAccountSession }));
vi.mock("@/lib/publisher-api", () => ({ appealPublisherModerationCase: mocks.appeal }));

import { appealModerationCase } from "./actions";

const caseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  Object.entries(fields).forEach(([key, value]) => data.set(key, value));
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASSETLIBRARY_PUBLIC_URL", "https://assets.neuro.example");
  mocks.headers.mockResolvedValue(new Headers({ origin: "https://assets.neuro.example" }));
  mocks.currentAccountSession.mockResolvedValue({
    ok: true, session: { access_token: "publisher-access-token-that-is-long-enough" },
  });
  mocks.appeal.mockResolvedValue({ ok: true, data: { status: "appealed" } });
});

describe("Publisher appeal Server Action", () => {
  it("submits one confirmed bounded appeal through the external session", async () => {
    await appealModerationCase({}, form({ case_id: caseId, idempotency_key: "appeal-key-123",
      reason: "Please reconsider the enforcement evidence.", confirm: "yes" }));
    expect(mocks.appeal).toHaveBeenCalledWith(
      "publisher-access-token-that-is-long-enough", caseId, "appeal-key-123",
      "Please reconsider the enforcement evidence.",
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/publisher/moderation/${caseId}`);
  });

  it("requires explicit confirmation before session lookup", async () => {
    await expect(appealModerationCase({}, form({ case_id: caseId, idempotency_key: "appeal-key-123",
      reason: "Please reconsider the enforcement evidence." })))
      .resolves.toEqual({ error: "请填写有效申诉理由并确认提交。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });

  it("fails closed before Account Service access on a cross-origin request", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(appealModerationCase({}, form({ case_id: caseId, idempotency_key: "appeal-key-123",
      reason: "Please reconsider the enforcement evidence.", confirm: "yes" })))
      .resolves.toEqual({ error: "请求来源验证失败，申诉未提交。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.appeal).not.toHaveBeenCalled();
  });
});
