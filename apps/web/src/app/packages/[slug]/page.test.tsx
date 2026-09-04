import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPackage, listPackageReleases } from "@/lib/public-api";
import PackagePage from "./page";

vi.mock("@/lib/public-api", () => ({ getPackage: vi.fn(), listPackageReleases: vi.fn() }));

const getPackageMock = vi.mocked(getPackage);
const listReleasesMock = vi.mocked(listPackageReleases);
const packageFixture = {
  id: "019b86dc-1111-7000-8000-000000000101",
  slug: "verified-art",
  name: "Verified Art",
  kind: "art" as const,
  publisher: { id: "publisher-id", slug: "neuro-labs", display_name: "Neuro Labs" },
  status: "published" as const,
  summary: "A real published package.",
};

beforeEach(() => {
  getPackageMock.mockReset();
  listReleasesMock.mockReset();
  getPackageMock.mockResolvedValue({ ok: true, data: packageFixture });
});

describe("package release SSR", () => {
  it("renders verified version, compatibility, permission, and digest data", async () => {
    listReleasesMock.mockResolvedValue({ ok: true, data: {
      schema_version: "1.0",
      items: [{
        id: "release-id",
        version: "1.2.0",
        published_at: "2026-09-03T08:00:00Z",
        compatibility: { products: [{ name: "loom", version_requirement: ">=0.1.0" }] },
        permissions: ["hook.selection.read"],
        artifacts: [{
          artifact_id: "artifact-id",
          release_id: "release-id",
          digest: "42".repeat(32),
          size_bytes: 4096,
          media_type: "application/zip",
          file_name: "verified-art-1.2.0.zip",
          signing_key_id: "release-key",
        }],
      }],
      next_cursor: null,
    } });

    const html = renderToStaticMarkup(await PackagePage({
      params: Promise.resolve({ slug: "verified-art" }),
      searchParams: Promise.resolve({}),
    }));

    expect(html).toContain("v1.2.0");
    expect(html).toContain("Loom");
    expect(html).toContain("hook.selection.read");
    expect(html).toContain("4242424242424242");
    expect(html).toContain("/publishers/neuro-labs");
    expect(html).toContain("最新公开版本");

    const olderPage = renderToStaticMarkup(await PackagePage({
      params: Promise.resolve({ slug: "verified-art" }),
      searchParams: Promise.resolve({ cursor: "opaque" }),
    }));
    expect(olderPage).not.toContain("最新公开版本");
  });

  it("renders release projection failure without hiding package identity", async () => {
    listReleasesMock.mockResolvedValue({ ok: false, failure: "unavailable" });
    const html = renderToStaticMarkup(await PackagePage({
      params: Promise.resolve({ slug: "verified-art" }),
      searchParams: Promise.resolve({}),
    }));

    expect(html).toContain("Verified Art");
    expect(html).toContain("版本信息暂时不可用");
  });

  it("rejects repeated cursors instead of silently returning the first page", async () => {
    const html = renderToStaticMarkup(await PackagePage({
      params: Promise.resolve({ slug: "verified-art" }),
      searchParams: Promise.resolve({ cursor: ["one", "two"] }),
    }));

    expect(html).toContain("分页链接已经失效");
    expect(listReleasesMock).not.toHaveBeenCalled();
  });
});
