import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { currentAccountSession } from "@/lib/account-session";
import { getOwnedPackage, getOwnedRelease, getPublisherReleaseWorkspace } from "@/lib/publisher-api";
import type { PublisherReleaseWorkspace } from "@/lib/publisher-workspace-contracts";
import PublisherReleasePage from "./page";

vi.mock("server-only", () => ({}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/lib/account-session", () => ({ accountLoginUrl: vi.fn(), currentAccountSession: vi.fn() }));
vi.mock("@/lib/publisher-api", () => ({
  getOwnedPackage: vi.fn(), getOwnedRelease: vi.fn(), getPublisherReleaseWorkspace: vi.fn(),
}));

const packageId = "22222222-2222-4222-8222-222222222222";
const releaseId = "33333333-3333-4333-8333-333333333333";
const token = "release-workspace-token-that-must-not-render";
const ownedPackage = { id: packageId, publisher_id: "11111111-1111-4111-8111-111111111111",
  slug: "neuro-painter", kind: "art" as const, status: "draft" as const, visibility: "private" as const,
  name: "Neuro Painter", summary: "Draft", description: "Package details", tags: ["art"],
  created_at: "2026-09-03T08:00:00Z", updated_at: "2026-09-03T08:00:00Z" };
const release = { id: releaseId, package_id: packageId, version: "1.0.0", status: "draft" as const,
  compatibility: { products: [{ name: "loom" as const, version_requirement: ">=0.1.0" }] },
  permissions: ["filesystem.read-project"], created_by: {
    issuer: "private-creator-issuer", subject: "private-creator-subject",
  }, published_at: null, yanked_at: null, created_at: "2026-09-03T08:00:00Z",
  updated_at: "2026-09-03T08:00:00Z" };
const workspace: PublisherReleaseWorkspace = {
  schema_version: "1.0", release_id: releaseId, artifacts: [{
    id: "55555555-5555-4555-8555-555555555555", status: "verified",
    file_name: "neuro-painter-1.0.0.zip", size_bytes: 1_048_576, media_type: "application/zip",
    expected_digest: `sha256:${"a".repeat(64)}`, verified_digest: `sha256:${"a".repeat(64)}`,
    scanner_version: "asset-scanner-1", rule_version: "rules-2026-09",
    verified_at: "2026-09-03T08:05:00Z", created_at: "2026-09-03T08:00:00Z",
    updated_at: "2026-09-03T08:05:00Z",
  }], artifacts_truncated: false, submission: null, feedback: [{
    revision: 1, decision: "needs_changes", reason: "Declare the network permission.",
    findings: [{ code: "manifest.permission", severity: "error", message: "Permission is missing." }],
    decided_at: "2026-09-03T08:08:00Z",
  }], feedback_truncated: false, can_upload: true,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(currentAccountSession).mockResolvedValue({ ok: true, session: {
    principal: { issuer: "https://accounts.example", subject: "release-workspace-subject" },
    access_token: token, expires_at: "2099-01-01T00:00:00Z",
  } });
  vi.mocked(getOwnedPackage).mockResolvedValue({ ok: true, data: ownedPackage });
  vi.mocked(getOwnedRelease).mockResolvedValue({ ok: true, data: release });
  vi.mocked(getPublisherReleaseWorkspace).mockResolvedValue({ ok: true, data: workspace });
});

describe("Publisher Release workspace SSR", () => {
  it("renders an optimistic draft edit form without creator identity", async () => {
    const html = renderToStaticMarkup(await PublisherReleasePage({
      params: Promise.resolve({ packageId, releaseId }),
    }));
    expect(html).toContain("RELEASE CONTROL PLANE");
    expect(html).toContain("保存 Release 草稿");
    expect(html).toContain("neuro-painter-1.0.0.zip");
    expect(html).toContain("上传 ZIP Artifact");
    expect(html).toContain("提交 Artifact 审核");
    expect(html).toContain("Declare the network permission.");
    expect(html).toContain("&gt;=0.1.0");
    for (const secret of [token, "release-workspace-subject", "private-creator-issuer",
      "private-creator-subject"]) expect(html).not.toContain(secret);
  });

  it("locks metadata outside draft state", async () => {
    vi.mocked(getOwnedRelease).mockResolvedValueOnce({ ok: true, data: {
      ...release, status: "in_review",
    } });
    vi.mocked(getPublisherReleaseWorkspace).mockResolvedValueOnce({ ok: true, data: {
      ...workspace, can_upload: false, submission: {
        id: "44444444-4444-4444-8444-444444444444", artifact_id: workspace.artifacts[0].id,
        revision: 2, status: "in_review", required_approvals: 2, approval_count: 0,
        submitted_at: "2026-09-03T08:10:00Z", updated_at: "2026-09-03T08:10:00Z",
      },
    } });
    const html = renderToStaticMarkup(await PublisherReleasePage({
      params: Promise.resolve({ packageId, releaseId }),
    }));
    expect(html).toContain("Release 元数据已锁定");
    expect(html).toContain("审核中");
    expect(html).not.toContain("保存 Release 草稿");
    expect(html).not.toContain("提交 Artifact 审核");
  });
});
