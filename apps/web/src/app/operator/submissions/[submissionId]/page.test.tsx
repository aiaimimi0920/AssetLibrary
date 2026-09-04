import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { getOperatorSubmission } from "@/lib/operator-api";
import DetailPage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/operator-api", () => ({ getOperatorSubmission: vi.fn() }));

const sessionMock = vi.mocked(currentAccountSession);
const getMock = vi.mocked(getOperatorSubmission);
const accessToken = "secret-operator-token-that-must-not-render";
const detail = JSON.parse(readFileSync(new URL(
  "../../../../../../../contracts/fixtures/operator-submission-detail.v1.json", import.meta.url,
), "utf8"));

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "private-reviewer-subject" },
    access_token: accessToken, expires_at: "2099-01-01T00:00:00Z",
  } });
});

describe("Operator Submission SSR", () => {
  it("renders sanitized evidence and a revision-bound action without secrets", async () => {
    getMock.mockResolvedValue({ ok: true, data: detail });
    const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({
      submissionId: detail.item.submission.id,
    }) }));
    expect(html).toContain("可审核制品事实");
    expect(html).toContain(detail.evidence.digest);
    expect(html).toContain("提交审核决定");
    expect(html).not.toContain(accessToken);
    expect(html).not.toContain("private-reviewer-subject");
    expect(html).not.toContain("object_key");
    expect(html).not.toContain("scan_evidence");
  });

  it("stops before detail access when the session is unavailable", async () => {
    sessionMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    const html = renderToStaticMarkup(await DetailPage({ params: Promise.resolve({
      submissionId: detail.item.submission.id,
    }) }));
    expect(html).toContain("账号服务暂时不可用");
    expect(getMock).not.toHaveBeenCalled();
  });
});
