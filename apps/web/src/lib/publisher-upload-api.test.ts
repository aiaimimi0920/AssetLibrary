import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  completePublisherUploadSession,
  createPublisherUploadSession,
  getPublisherUploadSession,
  presignPublisherUploadPart,
} from "./publisher-api";

vi.mock("server-only", () => ({}));

const token = "publisher-upload-token-that-is-long-enough";
const releaseId = "33333333-3333-4333-8333-333333333333";
const sessionId = "66666666-6666-4666-8666-666666666666";
const artifactId = "55555555-5555-4555-8555-555555555555";
const checksum = `${"A".repeat(43)}=`;
const digest = `sha256:${"a".repeat(64)}`;
const session = { id: sessionId, release_id: releaseId, artifact_id: artifactId,
  object_key: "quarantine/release/artifact/package.zip", part_size_bytes: 8_388_608,
  max_parts: 1, expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload",
  expected_digest: { algorithm: "sha256", value: digest } };

beforeEach(() => vi.stubEnv("ASSETLIBRARY_UPLOAD_ORIGINS", "https://uploads.example"));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Publisher upload API client", () => {
  it("executes create, presign, and complete through server-only bearer calls", async () => {
    const signed = { part_number: 1, method: "PUT",
      url: "https://uploads.example/object?signed=yes",
      headers: { "x-amz-checksum-sha256": checksum }, expires_in_seconds: 900 };
    const recovery = { id: sessionId, release_id: releaseId, artifact_id: artifactId,
      part_size_bytes: 8_388_608, max_parts: 1, size_bytes: 4,
      expires_at_epoch_seconds: 2_147_483_647, status: "pending_upload",
      expected_digest: { algorithm: "sha256", value: digest }, uploaded_parts: [] };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(session), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(recovery), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(signed), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...session, status: "uploaded" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(createPublisherUploadSession(token, releaseId, "browser-upload-key", {
      file_name: "package.zip", media_type: "application/zip", size_bytes: 4,
      part_size_bytes: 8_388_608, part_count: 1,
      expected_digest: { algorithm: "sha256", value: digest },
    })).resolves.toMatchObject({ ok: true, data: { id: sessionId } });
    await expect(getPublisherUploadSession(token, sessionId))
      .resolves.toMatchObject({ ok: true, data: { size_bytes: 4, uploaded_parts: [] } });
    await expect(presignPublisherUploadPart(token, sessionId, 1, {
      size_bytes: 4, checksum_sha256_base64: checksum,
    })).resolves.toMatchObject({ ok: true, data: { method: "PUT" } });
    await expect(completePublisherUploadSession(token, sessionId, [{
      part_number: 1, etag: '"etag"', checksum_sha256_base64: checksum,
    }])).resolves.toMatchObject({ ok: true, data: { status: "uploaded" } });

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "browser-upload-key" } });
    expect((fetchMock.mock.calls[1]?.[0] as URL).pathname)
      .toBe(`/v1/me/upload-sessions/${sessionId}`);
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: "GET", cache: "no-store" });
    expect((fetchMock.mock.calls[2]?.[0] as URL).pathname)
      .toBe(`/v1/me/upload-sessions/${sessionId}/parts/1`);
    expect((fetchMock.mock.calls[3]?.[0] as URL).pathname)
      .toBe(`/v1/me/upload-sessions/${sessionId}/complete`);
  });

  it("rejects malformed identifiers before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(createPublisherUploadSession(token, "invalid", "browser-upload-key", {
      file_name: "package.zip", media_type: "application/zip", size_bytes: 4,
      part_size_bytes: 8_388_608, part_count: 1,
      expected_digest: { algorithm: "sha256", value: digest },
    })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(presignPublisherUploadPart(token, sessionId, 0, {
      size_bytes: 4, checksum_sha256_base64: checksum,
    })).resolves.toEqual({ ok: false, failure: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
