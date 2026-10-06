import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  appealPublisherModerationCase,
  getPublisherModerationCase,
  getOwnedPackage,
  getOwnedRelease,
  getPublisherReleaseWorkspace,
  listOwnedPackages,
  listPublisherModerationCases,
  listPublisherMemberships,
  submitPublisherRelease,
  updatePackage,
  updateRelease,
} from "./publisher-api";

vi.mock("server-only", () => ({}));

const token = "publisher-access-token-that-is-long-enough";
const publisherId = "11111111-1111-4111-8111-111111111111";
const packageId = "22222222-2222-4222-8222-222222222222";
const moderationPage = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/publisher-moderation-case-page.v1.json", import.meta.url,
), "utf8"));
const moderationDetail = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/publisher-moderation-case-detail.v1.json", import.meta.url,
), "utf8"));
const membershipPage = {
  schema_version: "1.0",
  items: [{
    publisher: { id: publisherId, slug: "neuro-labs", display_name: "Neuro Labs" },
    publisher_status: "active",
    role: "owner",
  }],
  next_cursor: null,
};
const packageSummary = {
  id: packageId,
  publisher_id: publisherId,
  slug: "neuro-painter",
  kind: "art",
  status: "draft",
  visibility: "private",
  name: "Neuro Painter",
  summary: "Real draft",
  tags: ["art"],
  created_at: "2026-09-03T08:00:00Z",
  updated_at: "2026-09-03T08:00:00Z",
};
const release = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/owned-release-page.v1.json", import.meta.url,
), "utf8")).items[0];
const releaseWorkspace = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/publisher-release-workspace.v1.json", import.meta.url,
), "utf8"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Publisher API server client", () => {
  it("sends the bearer only from the server and parses bounded private pages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(membershipPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        schema_version: "1.0", items: [packageSummary], next_cursor: null,
      }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ASSETLIBRARY_API_URL", "https://api.assets.example/base/");

    await expect(listPublisherMemberships(token, { limit: 100 })).resolves.toMatchObject({ ok: true });
    await expect(listOwnedPackages(token, publisherId, { limit: 24 })).resolves.toMatchObject({
      ok: true,
      data: { items: [{ slug: "neuro-painter" }] },
    });
    expect((fetchMock.mock.calls[0]?.[0] as URL).href).toBe("https://api.assets.example/v1/me/publishers?limit=100");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store",
      redirect: "error",
      headers: { authorization: `Bearer ${token}` },
    });
  });

  it("retrieves complete package metadata without accepting internal fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      ...packageSummary,
      description: "Full description",
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOwnedPackage(token, packageId)).resolves.toMatchObject({
      ok: true,
      data: { description: "Full description" },
    });
    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname).toBe(`/v1/me/packages/${packageId}`);
  });

  it("idempotently patches one owned package and enforces its response identity", async () => {
    const updated = { ...packageSummary, description: "Updated description", visibility: "unlisted" };
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(updated), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(updatePackage(token, packageId, "package-update-key", {
      expected_updated_at: packageSummary.updated_at,
      visibility: "unlisted",
      name: packageSummary.name,
      summary: packageSummary.summary,
      description: updated.description,
      tags: packageSummary.tags,
    })).resolves.toMatchObject({ ok: true, data: { id: packageId, visibility: "unlisted" } });
    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname).toBe(`/v1/me/packages/${packageId}`);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "PATCH", headers: { "idempotency-key": "package-update-key" },
    });

    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      ...updated, id: "44444444-4444-4444-8444-444444444444",
    }), { status: 200 }));
    await expect(updatePackage(token, packageId, "package-update-key-2", {
      expected_updated_at: updated.updated_at,
      visibility: "unlisted", name: updated.name, summary: updated.summary,
      description: updated.description, tags: updated.tags,
    })).resolves.toEqual({ ok: false, failure: "invalid_response" });
  });

  it("retrieves and idempotently patches one owned release", async () => {
    const updated = { ...release, permissions: ["filesystem.read-project", "network.fetch"] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(release), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(updated), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getOwnedRelease(token, release.id)).resolves.toMatchObject({
      ok: true, data: { version: "1.0.0" },
    });
    await expect(updateRelease(token, release.id, "release-update-key", {
      expected_updated_at: release.updated_at,
      compatibility: release.compatibility,
      permissions: updated.permissions,
    })).resolves.toMatchObject({ ok: true, data: { permissions: updated.permissions } });
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname).toBe(`/v1/me/releases/${release.id}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      headers: { "idempotency-key": "release-update-key" },
    });
  });

  it("reads a sanitized release workspace and submits one verified artifact", async () => {
    const submission = {
      id: releaseWorkspace.submission.id,
      release_id: releaseWorkspace.release_id,
      artifact_id: releaseWorkspace.submission.artifact_id,
      revision: releaseWorkspace.submission.revision,
      status: releaseWorkspace.submission.status,
      required_approvals: releaseWorkspace.submission.required_approvals,
      approval_count: releaseWorkspace.submission.approval_count,
      scanner_version: "asset-scanner-1",
      rule_version: "rules-2026-09",
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(releaseWorkspace), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(submission), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(getPublisherReleaseWorkspace(token, release.id)).resolves.toMatchObject({
      ok: true, data: { artifacts: [{ status: "verified" }] },
    });
    await expect(submitPublisherRelease(token, release.id, "release-submit-key",
      releaseWorkspace.artifacts[0].id)).resolves.toMatchObject({
      ok: true, data: { status: "in_review" },
    });
    expect((fetchMock.mock.calls[0]?.[0] as URL).pathname)
      .toBe(`/v1/me/releases/${release.id}/workspace`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: { "idempotency-key": "release-submit-key" },
      body: JSON.stringify({ artifact_id: releaseWorkspace.artifacts[0].id }),
    });
  });

  it("rejects invalid input and remote plaintext API configuration before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(listOwnedPackages(token, "not-a-uuid")).resolves.toEqual({
      ok: false, failure: "invalid_request",
    });
    await expect(getOwnedRelease(token, "not-a-uuid")).resolves.toEqual({
      ok: false, failure: "invalid_request",
    });
    vi.stubEnv("ASSETLIBRARY_API_URL", "http://api.assets.example");
    await expect(listPublisherMemberships(token)).resolves.toEqual({ ok: false, failure: "unavailable" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads scoped moderation projections and submits a bounded appeal", async () => {
    const caseId = moderationDetail.item.id;
    const caseView = { id: caseId, package_id: packageId,
      release_id: moderationDetail.item.release.id, status: "appealed" };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(moderationPage), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(moderationDetail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(caseView), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(listPublisherModerationCases(token, { limit: 30 })).resolves.toMatchObject({ ok: true });
    await expect(getPublisherModerationCase(token, caseId)).resolves.toMatchObject({
      ok: true, data: { can_appeal: true },
    });
    await expect(appealPublisherModerationCase(
      token, caseId, "publisher-appeal-key", "The evidence should be reconsidered.",
    )).resolves.toMatchObject({ ok: true, data: { status: "appealed" } });
    expect((fetchMock.mock.calls[0]?.[0] as URL).href)
      .toBe("http://127.0.0.1:8080/v1/me/moderation-cases?limit=30");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST", headers: { "idempotency-key": "publisher-appeal-key" },
      body: JSON.stringify({ reason: "The evidence should be reconsidered." }),
    });
  });

  it("rejects malformed moderation inputs before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getPublisherModerationCase(token, "not-a-uuid"))
      .resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(appealPublisherModerationCase(token, moderationDetail.item.id, "short", "Reason"))
      .resolves.toEqual({ ok: false, failure: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
