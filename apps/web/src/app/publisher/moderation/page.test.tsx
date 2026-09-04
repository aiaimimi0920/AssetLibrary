import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { listPublisherModerationCases } from "@/lib/publisher-api";
import PublisherModerationPage from "./page";

vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/publisher-api", () => ({ listPublisherModerationCases: vi.fn() }));

const sessionMock = vi.mocked(currentAccountSession);
const casesMock = vi.mocked(listPublisherModerationCases);
const accessToken = "publisher-access-token-that-must-not-render";
const page = JSON.parse(readFileSync(new URL(
  "../../../../../../contracts/fixtures/publisher-moderation-case-page.v1.json", import.meta.url,
), "utf8"));

beforeEach(() => {
  vi.clearAllMocks();
  sessionMock.mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "publisher-private-subject" },
    access_token: accessToken, expires_at: "2099-01-01T00:00:00Z",
  } });
  casesMock.mockResolvedValue({ ok: true, data: page });
});

describe("Publisher moderation queue SSR", () => {
  it("renders applied cases without Account or internal-report data", async () => {
    const html = renderToStaticMarkup(await PublisherModerationPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("处罚与申诉");
    expect(html).toContain("Neuro Painter");
    expect(html).toContain("The published release violates the malware policy.");
    expect(html).not.toContain(accessToken);
    expect(html).not.toContain("publisher-private-subject");
    expect(html).not.toContain("reporter_");
    expect(casesMock).toHaveBeenCalledWith(accessToken, { cursor: undefined, limit: 30 });
  });

  it("distinguishes an authorized empty case list from an API failure", async () => {
    casesMock.mockResolvedValueOnce({ ok: true, data: { schema_version: "1.0", items: [], next_cursor: null } });
    const empty = renderToStaticMarkup(await PublisherModerationPage({ searchParams: Promise.resolve({}) }));
    casesMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    const failed = renderToStaticMarkup(await PublisherModerationPage({ searchParams: Promise.resolve({}) }));
    expect(empty).toContain("没有已执行的处罚案件");
    expect(failed).toContain("Publisher 数据暂时不可用");
  });
});
