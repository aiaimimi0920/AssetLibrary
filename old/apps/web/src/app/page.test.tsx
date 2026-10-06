import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { listPackages } from "@/lib/public-api";
import Home from "./page";

vi.mock("@/lib/public-api", () => ({ listPackages: vi.fn() }));

const listPackagesMock = vi.mocked(listPackages);
const packageFixture = {
  id: "019b86dc-1111-7000-8000-000000000101",
  slug: "verified-art",
  name: "Verified Art",
  kind: "art" as const,
  publisher: {
    id: "019b86dc-1111-7000-8000-000000000001",
    slug: "neuro-labs",
    display_name: "Neuro Labs",
  },
  status: "published" as const,
  summary: "A real published package.",
};

beforeEach(() => listPackagesMock.mockReset());

describe("public catalog SSR", () => {
  it("renders primary package content into HTML", async () => {
    listPackagesMock.mockResolvedValue({
      ok: true,
      data: { schema_version: "1.0", items: [packageFixture], next_cursor: null },
    });

    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));

    expect(html).toContain('id="main-content"');
    expect(html).toContain("Verified Art");
    expect(html).toContain("A real published package.");
    expect(html).toContain("/packages/verified-art");
  });

  it("distinguishes a real empty result from API unavailability", async () => {
    listPackagesMock.mockResolvedValueOnce({
      ok: true,
      data: { schema_version: "1.0", items: [], next_cursor: null },
    });
    const emptyHtml = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));

    listPackagesMock.mockResolvedValueOnce({ ok: false, failure: "unavailable" });
    const unavailableHtml = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({}) }));

    expect(emptyHtml).toContain("当前分类还没有已发布包");
    expect(unavailableHtml).toContain("目录暂时不可用");
    expect(unavailableHtml).toContain("不会把依赖故障伪装成空目录");
  });

  it("rejects unknown filters without calling the API", async () => {
    const html = renderToStaticMarkup(await Home({ searchParams: Promise.resolve({ kind: "unknown" }) }));

    expect(listPackagesMock).not.toHaveBeenCalled();
    expect(html).toContain("目录请求无效");
  });
});
