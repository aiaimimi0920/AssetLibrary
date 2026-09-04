import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const actions = vi.hoisted(() => ({ create: vi.fn(), recover: vi.fn(), presign: vi.fn(), complete: vi.fn() }));
vi.mock("@/app/publisher/publisher-upload-actions", () => ({
  createUploadSessionAction: actions.create,
  recoverUploadSessionAction: actions.recover,
  presignUploadPartAction: actions.presign,
  completeUploadSessionAction: actions.complete,
}));

import {
  multipartPartCount,
  uploadPublisherFile,
  validateUploadFile,
} from "./publisher-upload-client";
import { readUploadResume, writeUploadResume } from "./publisher-upload-resume";

const releaseId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "55555555-5555-4555-8555-555555555555";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return { get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Publisher browser multipart controller", () => {
  it("plans bounded 8 MiB parts and rejects unsafe file names", () => {
    expect(multipartPartCount(8_388_609)).toBe(2);
    expect(validateUploadFile(new File([new Uint8Array([1])], "../unsafe.zip",
      { type: "application/zip" }))).toContain("文件名");
    expect(validateUploadFile(new File([new Uint8Array([1])], "safe.zip",
      { type: "application/zip" }))).toBeNull();
  });

  it("hashes locally, PUTs bytes directly, then completes the session", async () => {
    const file = new File([new Uint8Array([1, 2, 3, 4])], "safe.zip", { type: "application/zip" });
    const digest = "sha256:9f64a747e1b97f131fabb6b447296c9b6f0201e79fb3c5356e6c77e89b6a806a";
    actions.create.mockResolvedValue({ ok: true, data: { id: sessionId, artifact_id: artifactId,
      part_size_bytes: 8_388_608, max_parts: 1, expires_at_epoch_seconds: 2_147_483_647,
      status: "pending_upload", expected_digest: digest } });
    actions.presign.mockResolvedValue({ ok: true, data: { part_number: 1, method: "PUT",
      url: "https://uploads.example/object?signed=yes", headers: {}, expires_in_seconds: 900 } });
    actions.complete.mockResolvedValue({ ok: true, data: { id: sessionId, artifact_id: artifactId,
      part_size_bytes: 8_388_608, max_parts: 1, expires_at_epoch_seconds: 2_147_483_647,
      status: "uploaded", expected_digest: digest } });
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200,
      headers: { etag: '"object-etag"' } }));
    vi.stubGlobal("fetch", fetchMock);
    const progress = vi.fn();

    await expect(uploadPublisherFile(file, releaseId, new AbortController().signal, progress))
      .resolves.toBe(artifactId);
    expect(actions.create).toHaveBeenCalledWith(expect.objectContaining({ expected_digest: digest }));
    expect(fetchMock).toHaveBeenCalledWith("https://uploads.example/object?signed=yes",
      expect.objectContaining({ method: "PUT", body: expect.any(Blob), credentials: "omit" }));
    expect(actions.complete).toHaveBeenCalledWith(expect.objectContaining({
      session_id: sessionId, parts: [expect.objectContaining({ etag: '"object-etag"' })],
    }));
    expect(progress).toHaveBeenCalledWith({ stage: "finalizing", completed: 1, total: 1 });
  });

  it("re-presigns a failed part before retrying it", async () => {
    const file = new File([new Uint8Array([1])], "safe.zip", { type: "application/zip" });
    actions.create.mockImplementation(async (input: { expected_digest: string }) => ({ ok: true,
      data: { id: sessionId, artifact_id: artifactId, part_size_bytes: 8_388_608, max_parts: 1,
        expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload",
        expected_digest: input.expected_digest } }));
    actions.presign.mockResolvedValue({ ok: true, data: { part_number: 1, method: "PUT",
      url: "https://uploads.example/retry", headers: {}, expires_in_seconds: 900 } });
    actions.complete.mockImplementation(async () => ({ ok: true, data: { id: sessionId,
      artifact_id: artifactId, part_size_bytes: 8_388_608, max_parts: 1,
      expires_at_epoch_seconds: 2_147_483_647, status: "uploaded",
      expected_digest: "sha256:unused" } }));
    vi.stubGlobal("fetch", vi.fn()
      .mockRejectedValueOnce(new Error("temporary outage"))
      .mockResolvedValue(new Response(null, { status: 200, headers: { etag: '"retry-etag"' } })));

    await expect(uploadPublisherFile(file, releaseId, new AbortController().signal, vi.fn()))
      .resolves.toBe(artifactId);
    expect(actions.presign).toHaveBeenCalledTimes(2);
  });

  it("recovers authoritative matching parts after refresh and uploads only missing parts", async () => {
    const file = { name: "safe.zip", type: "application/zip", size: 8_388_609,
      slice: () => new Blob([new Uint8Array([1])], { type: "application/zip" }) } as unknown as File;
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1, 1])));
    const expectedDigest = `sha256:${[...digestBytes].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
    const checksumBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array([1])));
    const partChecksum = btoa(String.fromCharCode(...checksumBytes));
    vi.stubGlobal("window", { sessionStorage: memoryStorage() });
    writeUploadResume({ version: 1, release_id: releaseId, session_id: sessionId,
      artifact_id: artifactId, file_name: file.name, media_type: file.type, size_bytes: file.size,
      part_size_bytes: 8_388_608, part_count: 2, expires_at_epoch_seconds: 2_147_483_647,
      expected_digest: expectedDigest });
    actions.recover.mockResolvedValue({ ok: true, data: { id: sessionId, release_id: releaseId,
      artifact_id: artifactId, part_size_bytes: 8_388_608, max_parts: 2, size_bytes: file.size,
      expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload",
      expected_digest: expectedDigest, uploaded_parts: [{ part_number: 1, etag: '"kept"',
        checksum_sha256_base64: partChecksum, size_bytes: 1 }] } });
    actions.presign.mockResolvedValue({ ok: true, data: { part_number: 2, method: "PUT",
      url: "https://uploads.example/part-2", headers: {}, expires_in_seconds: 900 } });
    actions.complete.mockResolvedValue({ ok: true, data: { id: sessionId, artifact_id: artifactId,
      part_size_bytes: 8_388_608, max_parts: 2, expires_at_epoch_seconds: 2_147_483_647,
      status: "uploaded", expected_digest: expectedDigest } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null,
      { status: 200, headers: { etag: '"new"' } })));

    await expect(uploadPublisherFile(file, releaseId, new AbortController().signal, vi.fn()))
      .resolves.toBe(artifactId);
    expect(actions.create).not.toHaveBeenCalled();
    expect(actions.presign).toHaveBeenCalledWith(expect.objectContaining({ part_number: 2 }));
    expect(actions.complete).toHaveBeenCalledWith(expect.objectContaining({ parts: [
      expect.objectContaining({ part_number: 1, etag: '"kept"' }),
      expect.objectContaining({ part_number: 2, etag: '"new"' }),
    ] }));
    expect(readUploadResume(releaseId)).toBeNull();
  });

  it("keeps a recoverable session but rejects a different reselected file", async () => {
    vi.stubGlobal("window", { sessionStorage: memoryStorage() });
    writeUploadResume({ version: 1, release_id: releaseId, session_id: sessionId,
      artifact_id: artifactId, file_name: "original.zip", media_type: "application/zip",
      size_bytes: 1, part_size_bytes: 8_388_608, part_count: 1,
      expires_at_epoch_seconds: 2_147_483_647, expected_digest: `sha256:${"a".repeat(64)}` });
    const different = new File([new Uint8Array([1])], "different.zip", { type: "application/zip" });

    await expect(uploadPublisherFile(different, releaseId, new AbortController().signal, vi.fn()))
      .rejects.toThrow("所选文件与待恢复上传不一致");
    expect(actions.recover).not.toHaveBeenCalled();
    expect(actions.create).not.toHaveBeenCalled();
    expect(readUploadResume(releaseId)?.file_name).toBe("original.zip");
  });

  it("aborts peer workers when a part exhausts its retries", async () => {
    const file = { name: "safe.zip", type: "application/zip", size: 8_388_609,
      slice: () => new Blob([new Uint8Array([1])], { type: "application/zip" }) } as unknown as File;
    actions.create.mockImplementation(async (input: { expected_digest: string }) => ({ ok: true,
      data: { id: sessionId, artifact_id: artifactId, part_size_bytes: 8_388_608, max_parts: 2,
        expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload",
        expected_digest: input.expected_digest } }));
    actions.presign.mockImplementation(async (input: { part_number: number }) => ({ ok: true,
      data: { part_number: input.part_number, method: "PUT",
        url: `https://uploads.example/part-${input.part_number}`, headers: {}, expires_in_seconds: 900 } }));
    let peerAborted = false;
    vi.stubGlobal("fetch", vi.fn().mockImplementation((url: string, init: RequestInit) => {
      if (!url.endsWith("part-2")) return Promise.reject(new Error("persistent outage"));
      return new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal;
        signal.addEventListener("abort", () => {
          peerAborted = true;
          reject(new Error("peer aborted"));
        }, { once: true });
      });
    }));

    await expect(uploadPublisherFile(file, releaseId, new AbortController().signal, vi.fn()))
      .rejects.toThrow("分片 1 直传失败");
    expect(peerAborted).toBe(true);
    expect(actions.complete).not.toHaveBeenCalled();
  });
});
