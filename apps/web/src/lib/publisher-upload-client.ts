import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import {
  completeUploadSessionAction,
  createUploadSessionAction,
  presignUploadPartAction,
  recoverUploadSessionAction,
} from "@/app/publisher/publisher-upload-actions";
import type { CompletedBrowserPart, UploadActionResult } from "./publisher-upload-contracts";
import {
  clearUploadResume,
  readUploadResume,
  writeUploadResume,
} from "./publisher-upload-resume";

export const UPLOAD_PART_SIZE = 8 * 1024 * 1024;
export const MAX_UPLOAD_SIZE = 2 * 1024 * 1024 * 1024;
const allowedTypes = ["", "application/zip", "application/x-zip-compressed", "application/octet-stream"];

export interface UploadProgress {
  stage: "hashing" | "uploading" | "finalizing";
  completed: number;
  total: number;
}

function unwrap<T>(result: UploadActionResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

function cancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new Error("上传已取消；重新选择同一 ZIP 可恢复，过期后隔离区会话将自动清理。");
}

function base64(bytes: Uint8Array): string {
  let value = "";
  for (const byte of bytes) value += String.fromCharCode(byte);
  return btoa(value);
}

async function yieldToBrowser(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

async function waitBeforeRetry(attempt: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100 * 2 ** (attempt - 1)));
  cancelled(signal);
}

export function validateUploadFile(file: File): string | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,235}\.zip$/.test(file.name)) {
    return "文件名仅允许 ASCII 字母、数字、点、短横线和下划线，并且必须以 .zip 结尾。";
  }
  if (file.size < 1 || file.size > MAX_UPLOAD_SIZE) return "ZIP 文件大小必须在 1 byte 到 2 GiB 之间。";
  if (!allowedTypes.includes(file.type)) return "浏览器报告了不受支持的媒体类型。";
  return null;
}

export function multipartPartCount(size: number): number {
  return Math.ceil(size / UPLOAD_PART_SIZE);
}

async function fileDigest(file: File, signal: AbortSignal, progress: (value: UploadProgress) => void) {
  const hash = sha256.create();
  // Retain only part checksums so upload/recovery skip a second hashing read.
  const partChecksums: string[] = [];
  const chunks = multipartPartCount(file.size);
  for (let index = 0; index < chunks; index += 1) {
    cancelled(signal);
    const start = index * UPLOAD_PART_SIZE;
    const bytes = await file.slice(start, start + UPLOAD_PART_SIZE).arrayBuffer();
    cancelled(signal);
    hash.update(new Uint8Array(bytes));
    partChecksums.push(base64(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))));
    progress({ stage: "hashing", completed: index + 1, total: chunks });
    await yieldToBrowser();
  }
  return { expectedDigest: `sha256:${bytesToHex(hash.digest())}`, partChecksums };
}

function browserHeaders(headers: Record<string, string>): Headers {
  const result = new Headers();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower !== "host" && lower !== "content-length") result.set(name, value);
  }
  return result;
}

async function uploadPart(file: File, sessionId: string, partNumber: number,
  checksum: string, signal: AbortSignal): Promise<CompletedBrowserPart> {
  const start = (partNumber - 1) * UPLOAD_PART_SIZE;
  const blob = file.slice(start, Math.min(file.size, start + UPLOAD_PART_SIZE));
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    cancelled(signal);
    const signed = unwrap(await presignUploadPartAction({
      session_id: sessionId, part_number: partNumber, size_bytes: blob.size,
      checksum_sha256_base64: checksum,
    }));
    if (signed.part_number !== partNumber || signed.method !== "PUT") {
      throw new Error("上传控制平面返回了不匹配的分片授权。");
    }
    try {
      const response = await fetch(signed.url, { method: "PUT", headers: browserHeaders(signed.headers),
        body: blob, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer", signal });
      if (!response.ok) throw new Error(`object store returned HTTP ${response.status}`);
      const etag = response.headers.get("etag");
      if (!etag) throw new Error("对象存储未通过 CORS 暴露 ETag；请修复上传桶 CORS 配置。");
      return { part_number: partNumber, etag, checksum_sha256_base64: checksum };
    } catch (error) {
      if (signal.aborted) cancelled(signal);
      if (attempt === 3) {
        const detail = error instanceof Error ? error.message : "unknown object-store error";
        throw new Error(`分片 ${partNumber} 直传失败：${detail}`);
      }
      await waitBeforeRetry(attempt, signal);
    }
  }
  throw new Error(`分片 ${partNumber} 直传失败。`);
}

async function matchingRecoveredParts(file: File, parts: Array<CompletedBrowserPart & { size_bytes: number }>,
  partChecksums: readonly string[], signal: AbortSignal): Promise<CompletedBrowserPart[]> {
  const matching: CompletedBrowserPart[] = [];
  for (const part of parts) {
    cancelled(signal);
    const start = (part.part_number - 1) * UPLOAD_PART_SIZE;
    const blob = file.slice(start, Math.min(file.size, start + UPLOAD_PART_SIZE));
    if (blob.size !== part.size_bytes) continue;
    const checksum = partChecksums[part.part_number - 1];
    if (checksum === part.checksum_sha256_base64) {
      matching.push({ part_number: part.part_number, etag: part.etag,
        checksum_sha256_base64: part.checksum_sha256_base64 });
    }
    await yieldToBrowser();
  }
  return matching;
}

export async function uploadPublisherFile(file: File, releaseId: string, signal: AbortSignal,
  progress: (value: UploadProgress) => void): Promise<string> {
  const validation = validateUploadFile(file);
  if (validation) throw new Error(validation);
  const partCount = multipartPartCount(file.size);
  const { expectedDigest, partChecksums } = await fileDigest(file, signal, progress);
  cancelled(signal);
  const mediaType = file.type || "application/zip";
  const stored = readUploadResume(releaseId);
  if (stored && (stored.file_name !== file.name || stored.media_type !== mediaType
    || stored.size_bytes !== file.size
    || stored.expected_digest !== expectedDigest)) {
    throw new Error("所选文件与待恢复上传不一致；请重新选择原始 ZIP，或等待旧会话过期。");
  }
  const recovered = stored ? unwrap(await recoverUploadSessionAction({ session_id: stored.session_id })) : null;
  if (recovered && (recovered.id !== stored?.session_id || recovered.release_id !== releaseId
    || recovered.artifact_id !== stored.artifact_id || recovered.size_bytes !== file.size
    || recovered.part_size_bytes !== UPLOAD_PART_SIZE || recovered.max_parts !== partCount
    || recovered.expected_digest !== expectedDigest
    || recovered.expires_at_epoch_seconds <= Math.floor(Date.now() / 1_000))) {
    clearUploadResume(releaseId);
    throw new Error("服务端上传会话与本地恢复记录不一致，已拒绝继续直传。");
  }
  if (recovered?.status === "uploaded") {
    clearUploadResume(releaseId);
    return recovered.artifact_id;
  }
  const session = recovered ?? unwrap(await createUploadSessionAction({ release_id: releaseId,
    idempotency_key: crypto.randomUUID(), file_name: file.name, media_type: mediaType,
    size_bytes: file.size, part_size_bytes: UPLOAD_PART_SIZE,
    part_count: partCount, expected_digest: expectedDigest }));
  if (session.part_size_bytes !== UPLOAD_PART_SIZE || session.max_parts !== partCount
    || session.expected_digest !== expectedDigest
    || session.expires_at_epoch_seconds <= Math.floor(Date.now() / 1_000)) {
    throw new Error("上传会话与本地文件计划不一致，已拒绝直传。");
  }
  if (!recovered) writeUploadResume({ version: 1, release_id: releaseId, session_id: session.id,
    artifact_id: session.artifact_id, file_name: file.name, media_type: mediaType,
    size_bytes: file.size, part_size_bytes: UPLOAD_PART_SIZE, part_count: partCount,
    expires_at_epoch_seconds: session.expires_at_epoch_seconds, expected_digest: expectedDigest });
  const completed: Array<CompletedBrowserPart | undefined> = new Array(partCount);
  for (const part of await matchingRecoveredParts(file, recovered?.uploaded_parts ?? [], partChecksums, signal)) {
    completed[part.part_number - 1] = part;
  }
  const workerAbort = new AbortController();
  const forwardAbort = () => workerAbort.abort();
  if (signal.aborted) workerAbort.abort();
  else signal.addEventListener("abort", forwardAbort, { once: true });
  const pending = Array.from({ length: partCount }, (_, index) => index + 1)
    .filter((partNumber) => completed[partNumber - 1] === undefined);
  let next = 0;
  let uploaded = partCount - pending.length;
  if (uploaded > 0) progress({ stage: "uploading", completed: uploaded, total: partCount });
  const worker = async () => {
    while (next < pending.length) {
      const partNumber = pending[next];
      next += 1;
      completed[partNumber - 1] = await uploadPart(file, session.id, partNumber,
        partChecksums[partNumber - 1], workerAbort.signal);
      uploaded += 1;
      progress({ stage: "uploading", completed: uploaded, total: partCount });
    }
  };
  const workers = Array.from({ length: Math.min(3, pending.length) }, worker);
  try {
    await Promise.all(workers);
  } catch (error) {
    workerAbort.abort();
    await Promise.allSettled(workers);
    if (signal.aborted) cancelled(signal);
    throw error;
  } finally {
    signal.removeEventListener("abort", forwardAbort);
  }
  cancelled(signal);
  progress({ stage: "finalizing", completed: partCount, total: partCount });
  const parts = completed.filter((part): part is CompletedBrowserPart => part !== undefined);
  const done = unwrap(await completeUploadSessionAction({ session_id: session.id, parts }));
  if (done.status !== "uploaded" || done.artifact_id !== session.artifact_id) {
    throw new Error("上传完成响应与原会话不一致。");
  }
  clearUploadResume(releaseId);
  return done.artifact_id;
}
