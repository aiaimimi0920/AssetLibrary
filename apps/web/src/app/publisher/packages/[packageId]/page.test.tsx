import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { getOwnedPackage, listOwnedReleases, listPublisherMemberships } from "@/lib/publisher-api";
import PublisherPackagePage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/publisher-api", () => ({
  getOwnedPackage: vi.fn(), listOwnedReleases: vi.fn(), listPublisherMemberships: vi.fn(),
}));

const publisherId = "11111111-1111-4111-8111-111111111111";
const packageId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const accessToken = "package-workspace-token-that-must-not-render";

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentAccountSession).mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "package-workspace-subject" },
    access_token: accessToken, expires_at: "2099-01-01T00:00:00Z",
  } });
  vi.mocked(getOwnedPackage).mockResolvedValue({ ok: true, data: {
    id: packageId, publisher_id: publisherId, slug: "neuro-painter", kind: "art", status: "draft",
    visibility: "private", name: "Neuro Painter", summary: "Draft", description: "Package details",
    tags: ["art"], created_at: "2026-09-03T08:00:00Z", updated_at: "2026-09-03T08:00:00Z",
  } });
  vi.mocked(listPublisherMemberships).mockResolvedValue({ ok: true, data: {
    schema_version: "1.0", items: [{ publisher: { id: publisherId, slug: "neuro-labs",
      display_name: "Neuro Labs" }, publisher_status: "active", role: "owner" }], next_cursor: null,
  } });
  vi.mocked(listOwnedReleases).mockResolvedValue({ ok: true, data: {
    schema_version: "1.0", items: [{ id: releaseId, package_id: packageId, version: "1.0.0",
      status: "draft", compatibility: { products: [] }, permissions: [], created_by: {
        issuer: "private-creator-issuer", subject: "private-creator-subject",
      }, published_at: null, yanked_at: null, created_at: "2026-09-03T08:00:00Z",
      updated_at: "2026-09-03T08:00:00Z" }], next_cursor: null,
  } });
});

describe("Publisher Package workspace SSR", () => {
  it("renders real release state without bearer or creator identity", async () => {
    const html = renderToStaticMarkup(await PublisherPackagePage({
      params: Promise.resolve({ packageId }),
    }));
    expect(html).toContain("PACKAGE RELEASE WORKSPACE");
    expect(html).toContain("Neuro Painter");
    expect(html).toContain("v1.0.0");
    expect(html).toContain("管理 Release");
    expect(html).toContain("保存 Package 草稿");
    expect(html).toContain("neuro-painter · art");
    for (const secret of [accessToken, "package-workspace-subject", "private-creator-issuer",
      "private-creator-subject"]) expect(html).not.toContain(secret);
  });

  it("does not expose package editing to a release manager", async () => {
    vi.mocked(listPublisherMemberships).mockResolvedValueOnce({ ok: true, data: {
      schema_version: "1.0", items: [{ publisher: { id: publisherId, slug: "neuro-labs",
        display_name: "Neuro Labs" }, publisher_status: "active", role: "release_manager" }],
      next_cursor: null,
    } });
    const html = renderToStaticMarkup(await PublisherPackagePage({ params: Promise.resolve({ packageId }) }));
    expect(html).toContain("Package 元数据已锁定");
    expect(html).not.toContain("保存 Package 草稿");
    expect(html).toContain("创建 Release");
  });

  it("fails closed when active membership disappears", async () => {
    vi.mocked(listPublisherMemberships).mockResolvedValueOnce({ ok: true, data: {
      schema_version: "1.0", items: [], next_cursor: null,
    } });
    const html = renderToStaticMarkup(await PublisherPackagePage({ params: Promise.resolve({ packageId }) }));
    expect(html).toContain("没有访问该工作区的权限");
    expect(html).not.toContain("Package details");
  });
});
