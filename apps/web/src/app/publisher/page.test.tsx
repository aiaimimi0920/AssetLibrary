import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listOwnedPackages, listPublisherMemberships } from "@/lib/publisher-api";
import PublisherPage from "./page";

vi.mock("@/lib/account-session", () => ({
  accountLoginUrl: vi.fn(),
  currentAccountSession: vi.fn(),
}));
vi.mock("@/lib/publisher-api", () => ({
  listOwnedPackages: vi.fn(),
  listPublisherMemberships: vi.fn(),
}));

const sessionMock = vi.mocked(currentAccountSession);
const loginMock = vi.mocked(accountLoginUrl);
const membershipsMock = vi.mocked(listPublisherMemberships);
const packagesMock = vi.mocked(listOwnedPackages);
const publisherId = "11111111-1111-4111-8111-111111111111";
const accessToken = "secret-publisher-access-token-that-must-not-render";
const membership = {
  publisher: { id: publisherId, slug: "neuro-labs", display_name: "Neuro Labs" },
  publisher_status: "active" as const,
  role: "owner" as const,
};
const ownedPackage = {
  id: "22222222-2222-4222-8222-222222222222",
  publisher_id: publisherId,
  slug: "neuro-painter",
  kind: "art" as const,
  status: "draft" as const,
  visibility: "private" as const,
  name: "Neuro Painter",
  summary: "A real private draft.",
  tags: ["art"],
  created_at: "2026-09-03T08:00:00Z",
  updated_at: "2026-09-03T08:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  loginMock.mockReturnValue(null);
  sessionMock.mockResolvedValue({
    ok: true,
    session: {
      principal: { issuer: "https://accounts.example", subject: "private-subject" },
      access_token: accessToken,
      expires_at: "2099-01-01T00:00:00Z",
    },
  });
  membershipsMock.mockResolvedValue({
    ok: true,
    data: { schema_version: "1.0", items: [membership], next_cursor: null },
  });
});

describe("Publisher Console SSR", () => {
  it("renders real owned resources without leaking external identity or bearer data", async () => {
    packagesMock.mockResolvedValue({
      ok: true,
      data: { schema_version: "1.0", items: [ownedPackage], next_cursor: null },
    });
    const html = renderToStaticMarkup(await PublisherPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("Neuro Labs");
    expect(html).toContain("Neuro Painter");
    expect(html).toContain("A real private draft.");
    expect(html).not.toContain(accessToken);
    expect(html).not.toContain("private-subject");
    expect(html).not.toContain("https://accounts.example");
  });

  it("distinguishes a real empty workspace from dependency failure", async () => {
    packagesMock.mockResolvedValueOnce({
      ok: true,
      data: { schema_version: "1.0", items: [], next_cursor: null },
    });
    const empty = renderToStaticMarkup(await PublisherPage({ searchParams: Promise.resolve({}) }));
    packagesMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    const unavailable = renderToStaticMarkup(await PublisherPage({ searchParams: Promise.resolve({}) }));

    expect(empty).toContain("这个工作区还没有 Package");
    expect(empty).toContain("真实空结果");
    expect(unavailable).toContain("Publisher 数据暂时不可用");
    expect(unavailable).toContain("不会把故障显示成空工作区");
  });

  it("stops before Publisher API access when the external session is absent", async () => {
    sessionMock.mockResolvedValueOnce({ ok: false, failure: "unauthenticated" });
    const html = renderToStaticMarkup(await PublisherPage({ searchParams: Promise.resolve({}) }));

    expect(html).toContain("需要外部账号会话");
    expect(membershipsMock).not.toHaveBeenCalled();
    expect(packagesMock).not.toHaveBeenCalled();
  });
});
