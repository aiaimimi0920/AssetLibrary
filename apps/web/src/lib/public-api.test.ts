import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getPackage,
  getPublisher,
  listPackageReleases,
  listPackages,
  searchPackages,
} from "./public-api";

const packageFixture = {
  id: "019b86dc-1111-7000-8000-000000000101",
  slug: "verified-art",
  name: "Verified Art",
  kind: "art",
  publisher: {
    id: "019b86dc-1111-7000-8000-000000000001",
    slug: "neuro-labs",
    display_name: "Neuro Labs",
  },
  status: "published",
  summary: "A verified package.",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("public API client", () => {
  it("encodes bounded catalog filters and validates the response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      schema_version: "1.0",
      items: [packageFixture],
      next_cursor: "next-page",
    }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ASSETLIBRARY_API_URL", "https://api.assets.example/base/");

    const result = await listPackages({ kind: "art", cursor: "opaque", limit: 24 });

    expect(result.ok && result.data.items[0]?.slug).toBe("verified-art");
    const requested = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requested.href).toBe("https://api.assets.example/v1/public/packages?kind=art&cursor=opaque&limit=24");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ cache: "no-store" });
  });

  it("does not turn dependency or contract failures into an empty page", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ schema_version: "1.0", items: "bad" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(searchPackages({ q: "art" })).resolves.toEqual({ ok: false, failure: "unavailable" });
    await expect(listPackages()).resolves.toEqual({ ok: false, failure: "invalid_response" });
  });

  it("preserves package not-found semantics", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPackage("art-package-one")).resolves.toEqual({ ok: false, failure: "not_found" });
    const requested = fetchMock.mock.calls[0]?.[0] as URL;
    expect(requested.pathname).toBe("/v1/public/packages/art-package-one");
  });

  it("reads publisher and release projections through bounded public routes", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0",
        publisher: packageFixture.publisher,
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0",
        items: [{
          id: "019b86dc-1111-7000-8000-000000000201",
          version: "1.0.0",
          published_at: "2026-09-03T08:00:00Z",
          compatibility: { products: [{ name: "loom", version_requirement: ">=0.1.0" }] },
          permissions: [],
          artifacts: [{
            artifact_id: "019b86dc-1111-7000-8000-000000000301",
            release_id: "019b86dc-1111-7000-8000-000000000201",
            digest: "42".repeat(32),
            size_bytes: 1024,
            media_type: "application/zip",
            file_name: "verified-art-1.0.0.zip",
            signing_key_id: "release-key",
          }],
        }],
        next_cursor: null,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublisher("neuro-labs")).resolves.toMatchObject({ ok: true });
    await expect(listPackageReleases("verified-art", { limit: 20 })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ version: "1.0.0" }] },
    });
    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname).toBe("/v1/public/publishers/neuro-labs");
    expect((fetchMock.mock.calls[1]?.[0] as URL).href).toContain("/v1/public/packages/verified-art/releases?limit=20");
  });

  it("fails closed for an unsafe API protocol", async () => {
    vi.stubEnv("ASSETLIBRARY_API_URL", "file:///etc/passwd");
    await expect(listPackages()).resolves.toEqual({ ok: false, failure: "unavailable" });
  });

  it("rejects out-of-contract input before making a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPackages({ limit: 101 })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(searchPackages({ q: "" })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(getPackage("x".repeat(121))).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(getPackage("unsafe/slug")).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(getPublisher("Uppercase")).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(listPackageReleases("valid", { cursor: "x".repeat(257) })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(listPackages({ cursor: "line\nbreak" })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(searchPackages({ q: "line\nbreak" })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(searchPackages({ q: "valid", tag: " padded " })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
