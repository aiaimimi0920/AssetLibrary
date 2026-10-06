import { inspectArtPackage } from "../packages/art";
import { scanArchive, scanPolicy } from "../scanner/client";
import { objectMatches } from "../uploads/reconcile";
import { loadUpload, objectKey, type UploadEnv } from "../uploads/records";
import { ContentRejected, inspectPng } from "./png";
import {
  type InspectionRow,
  maxArchiveSize,
  maxObjectSize,
  packagePolicy,
  policy,
} from "./records";

/** 仅检查明确策略的受限对象；该缓冲是检查任务，不是元数据或下载路径。 */
async function readLimited(body: ReadableStream<Uint8Array>, expected: number, limit: number) {
  const reader = body.getReader();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 30000);
  const bytes = new Uint8Array(expected);
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > expected || size + value.byteLength > limit)
        throw new ContentRejected("OBJECT_SIZE_MISMATCH");
      bytes.set(value, size);
      size += value.byteLength;
    }
    if (timedOut) throw new Error("INSPECTION_READ_TIMEOUT");
    if (size !== expected) throw new ContentRejected("OBJECT_SIZE_MISMATCH");
    return bytes;
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function inspectObject(env: UploadEnv, row: InspectionRow) {
  const started = performance.now();
  if (row.policy !== policy && row.policy !== packagePolicy && row.policy !== scanPolicy)
    throw new ContentRejected("INSPECTION_POLICY_UNAVAILABLE");
  const limit = row.policy === policy ? maxObjectSize : maxArchiveSize;
  if (row.expected_size < 1 || row.expected_size > limit)
    throw new ContentRejected("OBJECT_SIZE_MISMATCH");
  const upload = await loadUpload(env.DB, row.upload_id);
  const object = await env.QUARANTINE.get(objectKey(upload), { onlyIf: { etagMatches: row.etag } });
  if (!object) throw new ContentRejected("OBJECT_MISSING");
  if (!("body" in object)) throw new ContentRejected("OBJECT_IDENTITY_CHANGED");
  if (
    !objectMatches(
      { ...upload, expected_size: row.expected_size, sha256: row.sha256, etag: row.etag },
      object,
    )
  ) {
    await object.body.cancel();
    throw new ContentRejected("OBJECT_IDENTITY_CHANGED");
  }
  const bytes = await readLimited(object.body, row.expected_size, limit);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const sha256 = [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
  if (sha256 !== row.sha256) throw new ContentRejected("OBJECT_DIGEST_MISMATCH");
  const result = row.policy === policy ? await inspectPng(bytes) : await inspectArtPackage(bytes);
  const scan = row.policy === scanPolicy ? await scanArchive(env, bytes, sha256) : undefined;
  return {
    ...result,
    ...(scan ? { scan } : {}),
    bytesRead: bytes.length,
    sha256,
    elapsedMs: Math.round(performance.now() - started),
  };
}
