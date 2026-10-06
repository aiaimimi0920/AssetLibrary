import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ create: vi.fn(), recover: vi.fn(), presign: vi.fn(), complete: vi.fn() }));
vi.mock("@/app/publisher/publisher-upload-actions", () => ({
  createUploadSessionAction: actions.create,
  recoverUploadSessionAction: actions.recover,
  presignUploadPartAction: actions.presign,
  completeUploadSessionAction: actions.complete,
}));

import { UPLOAD_PART_SIZE, uploadPublisherFile } from "./publisher-upload-client";
import { writeUploadResume } from "./publisher-upload-resume";

const releaseId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "55555555-5555-4555-8555-555555555555";

function fixture() {
  const bytes = new Uint8Array(UPLOAD_PART_SIZE + 7).fill(17);
  bytes.fill(29, UPLOAD_PART_SIZE);
  const file = new File([bytes], "safe.zip", { type: "application/zip" });
  const expectedDigest = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  const checksums = [bytes.subarray(0, UPLOAD_PART_SIZE), bytes.subarray(UPLOAD_PART_SIZE)]
    .map((part) => createHash("sha256").update(part).digest("base64"));
  const session = { id: sessionId, artifact_id: artifactId, part_size_bytes: UPLOAD_PART_SIZE,
    max_parts: 2, expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload", expected_digest: expectedDigest };
  actions.create.mockResolvedValue({ ok: true, data: session });
  actions.presign.mockImplementation(async ({ part_number }: { part_number: number }) => ({
    ok: true, data: { part_number, method: "PUT", url: `https://uploads.example/part-${part_number}`,
      headers: {}, expires_in_seconds: 900 },
  }));
  actions.complete.mockResolvedValue({ ok: true, data: { ...session, status: "uploaded" } });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { headers: { etag: '"new"' } })));
  const reads = vi.spyOn(Blob.prototype, "arrayBuffer");
  return { file, expectedDigest, checksums, session, reads };
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("bounded multipart checksum reuse", () => {
  it("reads each part once for hashing and keeps whole-file and per-part checksums exact", async () => {
    const { file, expectedDigest, checksums, reads } = fixture();

    await expect(uploadPublisherFile(file, releaseId, new AbortController().signal, vi.fn()))
      .resolves.toBe(artifactId);

    expect(reads).toHaveBeenCalledTimes(2);
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({ expected_digest: expectedDigest }));
    for (const [index, checksum] of checksums.entries()) {
      expect(actions.presign).toHaveBeenCalledWith(expect.objectContaining({
        part_number: index + 1, checksum_sha256_base64: checksum,
        size_bytes: index === 0 ? UPLOAD_PART_SIZE : 7,
      }));
    }
    expect(actions.complete).toHaveBeenCalledWith({ session_id: sessionId, parts: checksums.map(
      (checksum, index) => ({ part_number: index + 1, etag: '"new"', checksum_sha256_base64: checksum }),
    ) });
  });

  it("reuses verified checksums during recovery but replaces a mismatching remote part", async () => {
    const { file, expectedDigest, checksums, session, reads } = fixture();
    const values = new Map<string, string>();
    vi.stubGlobal("window", { sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    } });
    writeUploadResume({ version: 1, release_id: releaseId, session_id: sessionId,
      artifact_id: artifactId, file_name: file.name, media_type: file.type, size_bytes: file.size,
      part_size_bytes: UPLOAD_PART_SIZE, part_count: 2, expected_digest: expectedDigest,
      expires_at_epoch_seconds: session.expires_at_epoch_seconds });
    actions.recover.mockResolvedValue({ ok: true, data: { ...session, release_id: releaseId,
      size_bytes: file.size, uploaded_parts: [
        { part_number: 1, etag: '"kept"', size_bytes: UPLOAD_PART_SIZE, checksum_sha256_base64: checksums[0] },
        { part_number: 2, etag: '"stale"', size_bytes: 7, checksum_sha256_base64: checksums[0] },
      ] } });

    await expect(uploadPublisherFile(file, releaseId, new AbortController().signal, vi.fn()))
      .resolves.toBe(artifactId);

    expect(reads).toHaveBeenCalledTimes(2);
    expect(actions.create).not.toHaveBeenCalled();
    expect(actions.presign).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ part_number: 2 }));
    expect(actions.complete).toHaveBeenCalledWith({ session_id: sessionId, parts: [
      { part_number: 1, etag: '"kept"', checksum_sha256_base64: checksums[0] },
      { part_number: 2, etag: '"new"', checksum_sha256_base64: checksums[1] },
    ] });
  });
});
