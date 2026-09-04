import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  currentAccountSession: vi.fn(),
  decideOperatorSubmission: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/account-session", () => ({ currentAccountSession: mocks.currentAccountSession }));
vi.mock("@/lib/operator-api", () => ({ decideOperatorSubmission: mocks.decideOperatorSubmission }));

import { decideSubmissionAction } from "./actions";

const submissionId = "44444444-4444-4444-8444-444444444444";

function decisionForm(): FormData {
  const data = new FormData();
  data.set("submission_id", submissionId);
  data.set("idempotency_key", "operator-review-123");
  data.set("decision", "needs_changes");
  data.set("reason", "Declare the requested permission.");
  data.set("finding_code", "manifest.permission");
  data.set("finding_severity", "warning");
  data.set("finding_message", "Permission declaration is missing.");
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASSETLIBRARY_PUBLIC_URL", "https://assets.neuro.example");
  mocks.headers.mockResolvedValue(new Headers({ origin: "https://assets.neuro.example" }));
  mocks.currentAccountSession.mockResolvedValue({
    ok: true,
    session: { access_token: "operator-access-token-that-is-long-enough" },
  });
  mocks.decideOperatorSubmission.mockResolvedValue({ ok: true, data: {} });
});

describe("Operator decision Server Action", () => {
  it("passes the bounded decision and idempotency key after same-origin verification", async () => {
    await decideSubmissionAction({}, decisionForm());
    expect(mocks.decideOperatorSubmission).toHaveBeenCalledWith(
      "operator-access-token-that-is-long-enough",
      submissionId,
      "operator-review-123",
      {
        decision: "needs_changes",
        reason: "Declare the requested permission.",
        findings: [{
          code: "manifest.permission",
          severity: "warning",
          message: "Permission declaration is missing.",
        }],
      },
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/operator/submissions/${submissionId}`);
  });

  it("rejects cross-origin mutation before session exchange", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(decideSubmissionAction({}, decisionForm())).resolves.toEqual({
      error: "请求来源验证失败，未提交决定。",
    });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.decideOperatorSubmission).not.toHaveBeenCalled();
  });

  it("surfaces a revision or state conflict without redirecting", async () => {
    mocks.decideOperatorSubmission.mockResolvedValue({ ok: false, failure: "conflict" });
    await expect(decideSubmissionAction({}, decisionForm())).resolves.toEqual({
      error: "Submission 状态或当前 revision 已发生变化，请刷新后重试。",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });
});
