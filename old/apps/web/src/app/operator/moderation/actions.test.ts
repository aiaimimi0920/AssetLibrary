import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  currentAccountSession: vi.fn(),
  propose: vi.fn(),
  approve: vi.fn(),
  resolve: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/account-session", () => ({ currentAccountSession: mocks.currentAccountSession }));
vi.mock("@/lib/operator-api", () => ({
  approveOperatorModerationAction: mocks.approve,
  proposeOperatorModerationAction: mocks.propose,
  resolveOperatorModerationCase: mocks.resolve,
}));

import {
  approveModerationAction,
  proposeModerationAction,
  resolveModerationAppeal,
} from "./actions";

const caseId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const actionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

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
    ok: true, session: { access_token: "moderator-access-token-that-is-long-enough" },
  });
  mocks.propose.mockResolvedValue({ ok: true, data: {} });
  mocks.approve.mockResolvedValue({ ok: true, data: {} });
  mocks.resolve.mockResolvedValue({ ok: true, data: {} });
});

describe("Operator Moderation Server Actions", () => {
  it("submits one bounded proposal after same-origin session exchange", async () => {
    await proposeModerationAction({}, form({
      case_id: caseId,
      idempotency_key: "propose-case-123",
      operation: "yank|release|33333333-3333-4333-8333-333333333333",
      reason: "Confirmed policy violation.",
    }));
    expect(mocks.propose).toHaveBeenCalledWith(
      "moderator-access-token-that-is-long-enough",
      caseId,
      "propose-case-123",
      {
        action: "yank",
        target_type: "release",
        target_ref: "33333333-3333-4333-8333-333333333333",
        reason: "Confirmed policy violation.",
      },
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/operator/moderation/${caseId}`);
  });

  it("requires explicit independent-approval confirmation", async () => {
    await expect(approveModerationAction({}, form({
      case_id: caseId, action_id: actionId, idempotency_key: "approve-case-123",
    }))).resolves.toEqual({ error: "请确认独立复核后再应用处罚。" });
    expect(mocks.approve).not.toHaveBeenCalled();
  });

  it("fails closed on cross-origin appeal resolution", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(resolveModerationAppeal({}, form({
      case_id: caseId,
      idempotency_key: "resolve-case-123",
      resolution: "upheld",
      reason: "Evidence remains valid.",
      confirm: "yes",
    }))).resolves.toEqual({ error: "请求来源或外部账号会话不可用，操作未提交。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
  });
});
