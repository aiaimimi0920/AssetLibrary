import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(), currentAccountSession: vi.fn(), create: vi.fn(), recover: vi.fn(),
  presign: vi.fn(), complete: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/account-session", () => ({ currentAccountSession: mocks.currentAccountSession }));
vi.mock("@/lib/publisher-api", () => ({
  createPublisherUploadSession: mocks.create,
  getPublisherUploadSession: mocks.recover,
  presignPublisherUploadPart: mocks.presign,
  completePublisherUploadSession: mocks.complete,
}));

import {
  completeUploadSessionAction,
  createUploadSessionAction,
  presignUploadPartAction,
  recoverUploadSessionAction,
} from "./publisher-upload-actions";

const releaseId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "55555555-5555-4555-8555-555555555555";
const checksum = `${"A".repeat(43)}=`;
const expectedDigest = `sha256:${"a".repeat(64)}`;
const apiSession = { id: sessionId, release_id: releaseId, artifact_id: artifactId,
  object_key: "quarantine/private/object.zip", part_size_bytes: 8_388_608, max_parts: 1,
  expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload", expected_digest: {
    algorithm: "sha256", value: expectedDigest,
  } };

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ASSETLIBRARY_PUBLIC_URL", "https://assets.neuro.example");
  vi.stubEnv("ASSETLIBRARY_UPLOAD_ORIGINS", "https://uploads.example");
  mocks.headers.mockResolvedValue(new Headers({ origin: "https://assets.neuro.example" }));
  mocks.currentAccountSession.mockResolvedValue({ ok: true, session: {
    access_token: "publisher-upload-token-that-is-long-enough",
  } });
  mocks.create.mockResolvedValue({ ok: true, data: apiSession });
  mocks.presign.mockResolvedValue({ ok: true, data: { part_number: 1, method: "PUT",
    url: "https://uploads.example/object?signed=yes", headers: {
      "x-amz-checksum-sha256": checksum,
    }, expires_in_seconds: 900 } });
  mocks.complete.mockResolvedValue({ ok: true, data: { ...apiSession, status: "uploaded" } });
  mocks.recover.mockResolvedValue({ ok: true, data: { ...apiSession, size_bytes: 4,
    uploaded_parts: [{ part_number: 1, etag: '"etag"', checksum_sha256_base64: checksum,
      size_bytes: 4 }] } });
});

describe("Publisher multipart upload Server Actions", () => {
  it("creates a sanitized browser session without exposing the object key", async () => {
    const result = await createUploadSessionAction({ release_id: releaseId,
      idempotency_key: "browser-upload-key", file_name: "package.zip",
      media_type: "application/zip", size_bytes: 4, part_size_bytes: 8_388_608,
      part_count: 1, expected_digest: expectedDigest });
    expect(result).toMatchObject({ ok: true, data: { id: sessionId, artifact_id: artifactId } });
    expect(JSON.stringify(result)).not.toContain("object_key");
  });

  it("presigns and completes only bounded ordered parts", async () => {
    await expect(presignUploadPartAction({ session_id: sessionId, part_number: 1,
      size_bytes: 4, checksum_sha256_base64: checksum })).resolves.toMatchObject({ ok: true });
    await expect(completeUploadSessionAction({ session_id: sessionId, parts: [{
      part_number: 1, etag: '"etag"', checksum_sha256_base64: checksum,
    }] })).resolves.toMatchObject({ ok: true, data: { status: "uploaded" } });
  });

  it("recovers only safe part metadata through a fresh authorized exchange", async () => {
    const result = await recoverUploadSessionAction({ session_id: sessionId });
    expect(result).toMatchObject({ ok: true, data: { id: sessionId, release_id: releaseId,
      uploaded_parts: [{ part_number: 1, etag: '"etag"' }] } });
    expect(JSON.stringify(result)).not.toContain("object_key");
    expect(mocks.recover).toHaveBeenCalledWith("publisher-upload-token-that-is-long-enough", sessionId);
  });

  it("rejects malformed metadata before Account Service access", async () => {
    await expect(createUploadSessionAction({ release_id: releaseId }))
      .resolves.toMatchObject({ ok: false });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });

  it("fails closed on cross-origin control-plane requests", async () => {
    mocks.headers.mockResolvedValue(new Headers({ origin: "https://attacker.example" }));
    await expect(presignUploadPartAction({ session_id: sessionId, part_number: 1,
      size_bytes: 4, checksum_sha256_base64: checksum }))
      .resolves.toEqual({ ok: false, error: "请求来源验证失败，上传未开始。" });
    expect(mocks.currentAccountSession).not.toHaveBeenCalled();
  });
});
