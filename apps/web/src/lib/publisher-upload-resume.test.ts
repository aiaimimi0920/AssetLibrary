import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearUploadResume,
  readUploadResume,
  writeUploadResume,
  type UploadResumeDescriptor,
} from "./publisher-upload-resume";

const releaseId = "33333333-3333-4333-8333-333333333333";

function memoryStorage() {
  const values = new Map<string, string>();
  const api: Storage = { get length() { return values.size; }, clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null, key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); }, setItem: (key, value) => { values.set(key, value); } };
  return { api, values };
}

function descriptor(): UploadResumeDescriptor {
  return { version: 1, release_id: releaseId,
    session_id: "66666666-6666-4666-8666-666666666666",
    artifact_id: "55555555-5555-4555-8555-555555555555",
    file_name: "safe.zip", media_type: "application/zip", size_bytes: 4,
    part_size_bytes: 8_388_608, part_count: 1, expires_at_epoch_seconds: 2_147_483_647,
    expected_digest: `sha256:${"a".repeat(64)}` };
}

afterEach(() => vi.unstubAllGlobals());

describe("upload resume descriptor", () => {
  it("persists only bounded non-secret metadata for one browser tab", () => {
    const store = memoryStorage();
    vi.stubGlobal("window", { sessionStorage: store.api });
    writeUploadResume(descriptor());
    expect(readUploadResume(releaseId)).toEqual(descriptor());
    const serialized = [...store.values.values()].join("");
    expect(serialized).not.toMatch(/object_key|access_token|presigned|signed_url|authorization/i);
    clearUploadResume(releaseId);
    expect(readUploadResume(releaseId)).toBeNull();
  });

  it("removes expired or shape-expanded records instead of trusting them", () => {
    const store = memoryStorage();
    vi.stubGlobal("window", { sessionStorage: store.api });
    const storageKey = `assetlibrary.upload.v1.${releaseId}`;
    store.api.setItem(storageKey, JSON.stringify({ ...descriptor(), expires_at_epoch_seconds: 1 }));
    expect(readUploadResume(releaseId)).toBeNull();
    store.api.setItem(storageKey, JSON.stringify({ ...descriptor(), object_key: "private" }));
    expect(readUploadResume(releaseId)).toBeNull();
  });
});
