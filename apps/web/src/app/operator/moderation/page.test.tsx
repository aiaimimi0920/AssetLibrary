import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { listOperatorModerationCases } from "@/lib/operator-api";
import Page from "./page";

vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/operator-api", () => ({ listOperatorModerationCases: vi.fn() }));

const queue = JSON.parse(readFileSync(new URL(
  "../../../../../../contracts/fixtures/operator-moderation-queue-page.v1.json", import.meta.url,
), "utf8"));
const session = vi.mocked(currentAccountSession);
const list = vi.mocked(listOperatorModerationCases);

beforeEach(() => {
  vi.clearAllMocks();
  session.mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "private-moderator" },
    access_token: "secret-moderator-access-token-value", expires_at: "2099-01-01T00:00:00Z",
  } });
});

describe("Operator Moderation queue SSR", () => {
  it("renders case facts without identity data", async () => {
    list.mockResolvedValue({ ok: true, data: queue });
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("Moderation Cases");
    expect(html).toContain(queue.items[0].reason_preview);
    expect(html).not.toContain("private-moderator");
    expect(html).not.toContain("secret-moderator-access-token-value");
  });

  it("does not disguise API outage as an empty queue", async () => {
    list.mockResolvedValue({ ok: false, failure: "unavailable" });
    const html = renderToStaticMarkup(await Page({ searchParams: Promise.resolve({}) }));
    expect(html).toContain("审核数据暂时不可用");
    expect(html).not.toContain("当前没有未解决案件");
  });
});
