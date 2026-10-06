import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { getOperatorModerationCase } from "@/lib/operator-api";
import Page from "./page";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/operator-api", () => ({
  approveOperatorModerationAction: vi.fn(),
  getOperatorModerationCase: vi.fn(),
  proposeOperatorModerationAction: vi.fn(),
  resolveOperatorModerationCase: vi.fn(),
}));

const detail = JSON.parse(readFileSync(new URL(
  "../../../../../../../contracts/fixtures/operator-moderation-case-detail.v1.json", import.meta.url,
), "utf8"));
const session = vi.mocked(currentAccountSession);
const getCase = vi.mocked(getOperatorModerationCase);

beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "private-moderator" },
    access_token: "secret-moderator-access-token-value", expires_at: "2099-01-01T00:00:00Z",
  } });
});

describe("Operator Moderation case SSR", () => {
  it("renders sanitized report, action, and appeal facts", async () => {
    getCase.mockResolvedValue({ ok: true, data: detail });
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: detail.item.id }) }));
    expect(html).toContain("举报事实");
    expect(html).toContain(detail.report_reason);
    expect(html).toContain("提交申诉结论");
    expect(html).not.toContain("private-moderator");
    expect(html).not.toContain("object_key");
    expect(html).not.toContain("scan_evidence");
  });

  it("stops before case access when the account service is unavailable", async () => {
    session.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    const html = renderToStaticMarkup(await Page({ params: Promise.resolve({ caseId: detail.item.id }) }));
    expect(html).toContain("账号服务暂时不可用");
    expect(getCase).not.toHaveBeenCalled();
  });
});
