import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePresignedUploadPart, parseUploadRecovery, parseUploadSession } from "./publisher-upload-parser";

const session = {
  id: "66666666-6666-4666-8666-666666666666",
  release_id: "33333333-3333-4333-8333-333333333333",
  artifact_id: "55555555-5555-4555-8555-555555555555",
  object_key: "quarantine/release/artifact/package.zip",
  part_size_bytes: 8_388_608,
  max_parts: 2,
  expires_at_epoch_seconds: 2_147_483_647,
  status: "pending_upload",
  expected_digest: { algorithm: "sha256", value: `sha256:${"a".repeat(64)}` },
};

beforeEach(() => vi.stubEnv("ASSETLIBRARY_UPLOAD_ORIGINS", "https://uploads.example"));
afterEach(() => vi.unstubAllEnvs());

describe("Publisher upload response parsers", () => {
  it("accepts bounded upload control-plane responses", () => {
    expect(parseUploadSession(session)).toMatchObject({ max_parts: 2, status: "pending_upload" });
    expect(parsePresignedUploadPart({
      part_number: 1,
      method: "PUT",
      url: "https://uploads.example/quarantine/object?X-Amz-Signature=signed",
      headers: { "x-amz-checksum-sha256": `${"A".repeat(43)}=` },
      expires_in_seconds: 900,
    })).toMatchObject({ method: "PUT", part_number: 1 });
  });

  it("rejects remote plaintext URLs and credential-bearing headers", () => {
    expect(() => parsePresignedUploadPart({
      part_number: 1, method: "PUT", url: "http://uploads.example/object",
      headers: {}, expires_in_seconds: 900,
    })).toThrow();
    expect(() => parsePresignedUploadPart({
      part_number: 1, method: "PUT", url: "https://uploads.example/object",
      headers: { authorization: "secret" }, expires_in_seconds: 900,
    })).toThrow();
  });

  it("rejects unknown fields and malformed digests", () => {
    expect(() => parseUploadSession({ ...session, storage_upload_id: "private" })).toThrow();
    expect(() => parseUploadSession({
      ...session, expected_digest: { algorithm: "sha256", value: `sha256:${"A".repeat(64)}` },
    })).toThrow();
  });

  it("accepts ordered recovery parts and rejects duplicate part numbers", () => {
    const recovery = { id: session.id, release_id: session.release_id, artifact_id: session.artifact_id,
      part_size_bytes: session.part_size_bytes, max_parts: 2, size_bytes: 8_388_609,
      expires_at_epoch_seconds: session.expires_at_epoch_seconds, status: "pending_upload",
      expected_digest: session.expected_digest, uploaded_parts: [{ part_number: 1, etag: '"etag"',
        checksum_sha256_base64: `${"A".repeat(43)}=`, size_bytes: 8_388_608 }] };
    expect(parseUploadRecovery(recovery)).toMatchObject({ uploaded_parts: [{ part_number: 1 }] });
    expect(() => parseUploadRecovery({ ...recovery,
      uploaded_parts: [recovery.uploaded_parts[0], recovery.uploaded_parts[0]] })).toThrow();
  });
});
