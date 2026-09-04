import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listOperatorReviewQueue } from "@/lib/operator-api";
import OperatorPage from "./page";

vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/operator-api", () => ({ listOperatorReviewQueue: vi.fn() }));

const sessionMock = vi.mocked(currentAccountSession);
const loginMock = vi.mocked(accountLoginUrl);
const queueMock = vi.mocked(listOperatorReviewQueue);
const accessToken = "secret-operator-token-that-must-not-render";
const item = {
  submission: {
    id: "44444444-4444-4444-8444-444444444444", release_id: "33333333-3333-4333-8333-333333333333",
    artifact_id: "55555555-5555-4555-8555-555555555555", revision: 1, status: "in_review" as const,
    required_approvals: 2 as const, approval_count: 0, scanner_version: "clamav-1.4", rule_version: "rules-v1",
  },
  package: {
    id: "22222222-2222-4222-8222-222222222222", slug: "neuro-capability", name: "Neuro Capability",
    kind: "capability" as const, summary: "Real queued package.",
    publisher: { id: "11111111-1111-4111-8111-111111111111", slug: "neuro-labs", display_name: "Neuro Labs" },
  },
  release_version: "1.2.0", submitted_at: "2026-09-03T08:00:00Z", updated_at: "2026-09-03T08:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks(); loginMock.mockReturnValue(null);
  sessionMock.mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "private-reviewer-subject" },
    access_token: accessToken, expires_at: "2099-01-01T00:00:00Z",
  } });
});

describe("Operator Queue SSR", () => {
  it("renders real queue facts without external identity or bearer data", async () => {
    queueMock.mockResolvedValue({ ok: true, data: { schema_version: "1.0", items: [item], next_cursor: null } });
    const html = renderToStaticMarkup(await OperatorPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Neuro Capability");
    expect(html).toContain("Real queued package.");
    expect(html).not.toContain(accessToken);
    expect(html).not.toContain("private-reviewer-subject");
    expect(html).not.toContain("https://accounts.example");
  });

  it("distinguishes an empty queue from API failure", async () => {
    queueMock.mockResolvedValueOnce({ ok: true, data: { schema_version: "1.0", items: [], next_cursor: null } });
    const empty = renderToStaticMarkup(await OperatorPage({ searchParams: Promise.resolve({}) }));
    queueMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    const failed = renderToStaticMarkup(await OperatorPage({ searchParams: Promise.resolve({}) }));
    expect(empty).toContain("当前没有待审核 Submission");
    expect(empty).toContain("真实空快照");
    expect(failed).toContain("审核数据暂时不可用");
    expect(failed).toContain("不会把故障伪装成空队列");
  });

  it("stops before API access without an external session", async () => {
    sessionMock.mockResolvedValueOnce({ ok: false, failure: "unauthenticated" });
    const html = renderToStaticMarkup(await OperatorPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("需要外部账号会话");
    expect(queueMock).not.toHaveBeenCalled();
  });
});
