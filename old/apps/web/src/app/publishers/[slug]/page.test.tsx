import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPublisher, listPackages } from "@/lib/public-api";
import PublisherPage from "./page";

vi.mock("@/lib/public-api", () => ({ getPublisher: vi.fn(), listPackages: vi.fn() }));

const getPublisherMock = vi.mocked(getPublisher);
const listPackagesMock = vi.mocked(listPackages);

beforeEach(() => {
  getPublisherMock.mockReset();
  listPackagesMock.mockReset();
});

describe("publisher SSR", () => {
  it("renders only the API publisher identity and its package projection", async () => {
    const publisher = { id: "publisher-id", slug: "neuro-labs", display_name: "Neuro Labs" };
    getPublisherMock.mockResolvedValue({ ok: true, data: { schema_version: "1.0", publisher } });
    listPackagesMock.mockResolvedValue({ ok: true, data: {
      schema_version: "1.0",
      items: [{
        id: "package-id",
        slug: "verified-art",
        name: "Verified Art",
        kind: "art",
        publisher,
        status: "published",
        summary: "A verified package.",
      }],
      next_cursor: null,
    } });

    const html = renderToStaticMarkup(await PublisherPage({
      params: Promise.resolve({ slug: "neuro-labs" }),
      searchParams: Promise.resolve({}),
    }));

    expect(html).toContain("Neuro Labs");
    expect(html).toContain("Verified Art");
    expect(html).toContain("这里只列出当前通过公开安装门禁的包");
    expect(listPackagesMock).toHaveBeenCalledWith({ publisher: "neuro-labs", cursor: undefined, limit: 24 });
  });

  it("rejects repeated cursors before listing publisher packages", async () => {
    const publisher = { id: "publisher-id", slug: "neuro-labs", display_name: "Neuro Labs" };
    getPublisherMock.mockResolvedValue({ ok: true, data: { schema_version: "1.0", publisher } });
    const html = renderToStaticMarkup(await PublisherPage({
      params: Promise.resolve({ slug: "neuro-labs" }),
      searchParams: Promise.resolve({ cursor: ["one", "two"] }),
    }));

    expect(html).toContain("目录请求无效");
    expect(listPackagesMock).not.toHaveBeenCalled();
  });
});
