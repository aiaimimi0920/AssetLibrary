import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(), currentAccountSession: vi.fn(), updatePackage: vi.fn(), updateRelease: vi.fn(),
  submitPublisherRelease: vi.fn(), redirect: vi.fn(), revalidatePath: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/account-session", () => ({ currentAccountSession: mocks.currentAccountSession }));
vi.mock("@/lib/publisher-api", () => ({
  createPackage: vi.fn(), createRelease: vi.fn(), updatePackage: mocks.updatePackage,
  updateRelease: mocks.updateRelease,
  submitPublisherRelease: mocks.submitPublisherRelease,
}));

import { submitReleaseAction, updatePackageAction, updateReleaseAction } from "./actions";

const packageId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const artifactId = "55555555-5555-4555-8555-555555555555";

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData();
  const fields = {
    package_id: packageId, release_id: releaseId, idempotency_key: "release-update-key",
    expected_updated_at: "2026-09-03T08:00:00Z", loom_requirement: ">=0.2.0",
    hook_requirement: "^0.1.0", permissions: "filesystem.read-project, network.fetch", ...overrides,
  };
  Object.entries(fields).forEach(([key, value]) => data.set(key, value));
  return data;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASSETLIBRARY_PUBLIC_URL", "https://assets.neuro.example");
  mocks.headers.mockResolvedValue(new Headers({ origin: "https://assets.neuro.example" }));
  mocks.currentAccountSession.mockResolvedValue({
    ok: true, session: { access_token: "publisher-access-token-that-is-long-enough" },
  });
  mocks.updateRelease.mockResolvedValue({ ok: true, data: { id: releaseId } });
  mocks.updatePackage.mockResolvedValue({ ok: true, data: { id: packageId } });
  mocks.submitPublisherRelease.mockResolvedValue({ ok: true, data: { id: releaseId } });
});

describe("Publisher package edit Server Action", () => {
  function packageForm(overrides: Record<string, string> = {}): FormData {
    const data = new FormData();
    const fields = {
      package_id: packageId, idempotency_key: "package-update-key",
      expected_updated_at: "2026-09-03T08:00:00Z", visibility: "unlisted",
      name: "Updated package", summary: "Updated summary", description: "Updated description",
      tags: "art, workflow", ...overrides,
    };
    Object.entries(fields).forEach(([key, value]) => data.set(key, value));
    return data;
  }

  it("submits bounded mutable metadata and preserves immutable fields outside the request", async () => {
    await updatePackageAction({}, packageForm());
    expect(mocks.updatePackage).toHaveBeenCalledWith(
      "publisher-access-token-that-is-long-enough", packageId, "package-update-key", {
        expected_updated_at: "2026-09-03T08:00:00Z",
        visibility: "unlisted",
        name: "Updated package",
        summary: "Updated summary",
        description: "Updated description",
        tags: ["art", "workflow"],
      },
    );
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/publisher/packages/${packageId}`);
    expect(mocks.redirect).toHaveBeenCalledWith(`/publisher/packages/${packageId}`);
  });

  it("rejects malformed concurrency state before Account Service access", async () => {
    await expect(updatePackageAction({}, packageForm({ expected_updated_at: "2026-09-03" })))
      .resolves.toEqual({ error: "请检查 Package、并发版本、标签和字段长度。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });

  it("fails closed on a cross-origin update", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(updatePackageAction({}, packageForm()))
      .resolves.toEqual({ error: "请求来源验证失败，Package 未更新。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.updatePackage).not.toHaveBeenCalled();
  });
});

describe("Publisher release submission Server Action", () => {
  function submissionForm(overrides: Record<string, string> = {}): FormData {
    const data = new FormData();
    const fields = { package_id: packageId, release_id: releaseId, artifact_id: artifactId,
      idempotency_key: "release-submit-key", confirm: "yes", ...overrides };
    Object.entries(fields).forEach(([key, value]) => data.set(key, value));
    return data;
  }

  it("submits a confirmed verified artifact and returns to the workspace", async () => {
    await submitReleaseAction({}, submissionForm());
    expect(mocks.submitPublisherRelease).toHaveBeenCalledWith(
      "publisher-access-token-that-is-long-enough", releaseId, "release-submit-key", artifactId,
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/publisher/packages/${packageId}/releases/${releaseId}`);
  });

  it("requires explicit confirmation before Account Service access", async () => {
    await expect(submitReleaseAction({}, submissionForm({ confirm: "no" })))
      .resolves.toEqual({ error: "请选择已验证的 Artifact，并确认提交审核。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });

  it("rejects cross-origin submission before Account Service access", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(submitReleaseAction({}, submissionForm()))
      .resolves.toEqual({ error: "请求来源验证失败，Release 未提交审核。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.submitPublisherRelease).not.toHaveBeenCalled();
  });
});

describe("Publisher release edit Server Action", () => {
  it("submits bounded editable fields with an optimistic timestamp", async () => {
    await updateReleaseAction({}, form());
    expect(mocks.updateRelease).toHaveBeenCalledWith(
      "publisher-access-token-that-is-long-enough", releaseId, "release-update-key", {
        expected_updated_at: "2026-09-03T08:00:00Z",
        compatibility: { products: [
          { name: "loom", version_requirement: ">=0.2.0" },
          { name: "hook", version_requirement: "^0.1.0" },
        ] },
        permissions: ["filesystem.read-project", "network.fetch"],
      },
    );
    expect(mocks.redirect).toHaveBeenCalledWith(`/publisher/packages/${packageId}/releases/${releaseId}`);
  });

  it("rejects a date-only concurrency token before Account Service access", async () => {
    await expect(updateReleaseAction({}, form({ expected_updated_at: "2026-09-03" })))
      .resolves.toEqual({ error: "请检查 Release、并发版本、兼容范围和权限列表。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });

  it("fails closed on cross-origin mutation before Account Service access", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(updateReleaseAction({}, form()))
      .resolves.toEqual({ error: "请求来源验证失败，Release 未更新。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
    expect(mocks.updateRelease).not.toHaveBeenCalled();
  });
});
