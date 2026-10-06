import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { getPublisherModerationCase } from "@/lib/publisher-api";
import PublisherModerationCasePage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/publisher-api", () => ({
  appealPublisherModerationCase: vi.fn(),
  getPublisherModerationCase: vi.fn(),
}));

const sessionMock = vi.mocked(currentAccountSession);
const caseMock = vi.mocked(getPublisherModerationCase);
const accessToken = "publisher-detail-token-that-must-not-render";
const detail = JSON.parse(readFileSync(new URL(
  "../../../../../../../contracts/fixtures/publisher-moderation-case-detail.v1.json", import.meta.url,
), "utf8"));

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "publisher-detail-subject" },
    access_token: accessToken, expires_at: "2099-01-01T00:00:00Z",
  } });
  caseMock.mockResolvedValue({ ok: true, data: detail });
});

describe("Publisher moderation detail SSR", () => {
  it("renders the enforcement notice and one appeal form without secrets", async () => {
    const html = renderToStaticMarkup(await PublisherModerationCasePage({
      params: Promise.resolve({ caseId: detail.item.id }),
    }));
    expect(html).toContain("ENFORCEMENT NOTICE");
    expect(html).toContain("提交正式申诉");
    expect(html).toContain("The published release violates the malware policy.");
    expect(html).not.toContain(accessToken);
    expect(html).not.toContain("publisher-detail-subject");
    expect(html).not.toContain("evidence_urls");
  });

  it("fails closed when the case is outside active memberships", async () => {
    caseMock.mockResolvedValueOnce({ ok: false, failure: "not_found" });
    const html = renderToStaticMarkup(await PublisherModerationCasePage({
      params: Promise.resolve({ caseId: detail.item.id }),
    }));
    expect(html).toContain("没有访问该工作区的权限");
  });
});
