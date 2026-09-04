"use server";

import { currentAccountSession } from "@/lib/account-session";
import { hasTrustedActionOrigin } from "@/lib/action-origin";
import {
  completePublisherUploadSession,
  createPublisherUploadSession,
  getPublisherUploadSession,
  presignPublisherUploadPart,
  type PublisherApiFailure,
} from "@/lib/publisher-api";
import type {
  BrowserUploadPart,
  BrowserUploadRecovery,
  BrowserUploadSession,
  CompletedBrowserPart,
  CreateBrowserUploadRequest,
  UploadActionResult,
} from "@/lib/publisher-upload-contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,235}\.zip$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const checksum = /^[A-Za-z0-9+/]{43}=$/;
const allowedMedia = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];
const PART_SIZE = 8 * 1024 * 1024;
const MAX_SIZE = 2 * 1024 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function failureMessage(failure: PublisherApiFailure): string {
  if (failure === "unauthenticated") return "外部账号会话已失效，请重新登录。";
  if (failure === "forbidden") return "当前成员或 Release 状态不允许上传。";
  if (failure === "conflict") return "上传会话状态发生冲突，请重新选择文件。";
  if (failure === "invalid_request") return "上传元数据不符合安全合同。";
  return "上传控制平面暂时不可用；文件字节尚未由 AssetLibrary API 接收。";
}

async function token(): Promise<UploadActionResult<string>> {
  if (!await hasTrustedActionOrigin()) return { ok: false, error: "请求来源验证失败，上传未开始。" };
  const session = await currentAccountSession();
  if (!session.ok) return { ok: false, error: "外部账号会话不可用，上传未开始。" };
  return { ok: true, data: session.session.access_token };
}

function safeSession(session: {
  id: string; artifact_id: string; part_size_bytes: number; max_parts: number;
  expires_at_epoch_seconds: number; status: "pending_upload" | "uploaded";
  expected_digest: { value: string };
}): BrowserUploadSession {
  return { id: session.id, artifact_id: session.artifact_id,
    part_size_bytes: session.part_size_bytes, max_parts: session.max_parts,
    expires_at_epoch_seconds: session.expires_at_epoch_seconds, status: session.status,
    expected_digest: session.expected_digest.value };
}

function safeRecovery(recovery: {
  id: string; release_id: string; artifact_id: string; part_size_bytes: number;
  max_parts: number; size_bytes: number; expires_at_epoch_seconds: number;
  status: "pending_upload" | "uploaded"; expected_digest: { value: string };
  uploaded_parts: BrowserUploadRecovery["uploaded_parts"];
}): BrowserUploadRecovery {
  return { id: recovery.id, release_id: recovery.release_id, artifact_id: recovery.artifact_id,
    part_size_bytes: recovery.part_size_bytes, max_parts: recovery.max_parts,
    size_bytes: recovery.size_bytes, expires_at_epoch_seconds: recovery.expires_at_epoch_seconds,
    status: recovery.status, expected_digest: recovery.expected_digest.value,
    uploaded_parts: recovery.uploaded_parts };
}

export async function createUploadSessionAction(input: unknown): Promise<UploadActionResult<BrowserUploadSession>> {
  const keys = ["release_id", "idempotency_key", "file_name", "media_type", "size_bytes",
    "part_size_bytes", "part_count", "expected_digest"];
  if (!exact(input, keys) || typeof input.release_id !== "string" || !uuid.test(input.release_id)
    || typeof input.idempotency_key !== "string" || input.idempotency_key.length < 8
    || input.idempotency_key.length > 200 || !/^[\x21-\x7e]+$/.test(input.idempotency_key)
    || typeof input.file_name !== "string" || !fileName.test(input.file_name)
    || typeof input.media_type !== "string" || !allowedMedia.includes(input.media_type)
    || !Number.isSafeInteger(input.size_bytes) || Number(input.size_bytes) < 1
    || Number(input.size_bytes) > MAX_SIZE || input.part_size_bytes !== PART_SIZE
    || !Number.isSafeInteger(input.part_count)
    || input.part_count !== Math.ceil(Number(input.size_bytes) / PART_SIZE)
    || typeof input.expected_digest !== "string" || !digest.test(input.expected_digest)) {
    return { ok: false, error: "请选择不超过 2 GiB、名称安全的 ZIP 文件。" };
  }
  const auth = await token();
  if (!auth.ok) return auth;
  const body: CreateBrowserUploadRequest = {
    file_name: input.file_name, media_type: input.media_type as CreateBrowserUploadRequest["media_type"],
    size_bytes: input.size_bytes as number, part_size_bytes: PART_SIZE,
    part_count: input.part_count as number,
    expected_digest: { algorithm: "sha256", value: input.expected_digest },
  };
  const result = await createPublisherUploadSession(
    auth.data, input.release_id, input.idempotency_key, body,
  );
  return result.ok ? { ok: true, data: safeSession(result.data) }
    : { ok: false, error: failureMessage(result.failure) };
}

export async function presignUploadPartAction(input: unknown): Promise<UploadActionResult<BrowserUploadPart>> {
  if (!exact(input, ["session_id", "part_number", "size_bytes", "checksum_sha256_base64"])
    || typeof input.session_id !== "string" || !uuid.test(input.session_id)
    || !Number.isInteger(input.part_number) || Number(input.part_number) < 1
    || Number(input.part_number) > 256 || !Number.isInteger(input.size_bytes)
    || Number(input.size_bytes) < 1 || Number(input.size_bytes) > PART_SIZE
    || typeof input.checksum_sha256_base64 !== "string" || !checksum.test(input.checksum_sha256_base64)) {
    return { ok: false, error: "上传分片元数据无效。" };
  }
  const auth = await token();
  if (!auth.ok) return auth;
  const result = await presignPublisherUploadPart(auth.data, input.session_id,
    input.part_number as number, { size_bytes: input.size_bytes as number,
      checksum_sha256_base64: input.checksum_sha256_base64 });
  return result.ok ? { ok: true, data: result.data }
    : { ok: false, error: failureMessage(result.failure) };
}

export async function recoverUploadSessionAction(input: unknown): Promise<UploadActionResult<BrowserUploadRecovery>> {
  if (!exact(input, ["session_id"]) || typeof input.session_id !== "string"
    || !uuid.test(input.session_id)) {
    return { ok: false, error: "恢复上传会话的标识无效。" };
  }
  const auth = await token();
  if (!auth.ok) return auth;
  const result = await getPublisherUploadSession(auth.data, input.session_id);
  return result.ok ? { ok: true, data: safeRecovery(result.data) }
    : { ok: false, error: failureMessage(result.failure) };
}

export async function completeUploadSessionAction(input: unknown): Promise<UploadActionResult<BrowserUploadSession>> {
  if (!exact(input, ["session_id", "parts"]) || typeof input.session_id !== "string"
    || !uuid.test(input.session_id) || !Array.isArray(input.parts)
    || input.parts.length < 1 || input.parts.length > 256) {
    return { ok: false, error: "上传完成清单无效。" };
  }
  const parts: CompletedBrowserPart[] = [];
  for (const [index, part] of input.parts.entries()) {
    if (!exact(part, ["part_number", "etag", "checksum_sha256_base64"])
      || part.part_number !== index + 1 || typeof part.etag !== "string"
      || part.etag.length < 1 || part.etag.length > 200 || part.etag.trim() !== part.etag
      || /[\u0000-\u001f\u007f]/.test(part.etag)
      || typeof part.checksum_sha256_base64 !== "string" || !checksum.test(part.checksum_sha256_base64)) {
      return { ok: false, error: "上传完成清单无效。" };
    }
    parts.push(part as unknown as CompletedBrowserPart);
  }
  const auth = await token();
  if (!auth.ok) return auth;
  const result = await completePublisherUploadSession(auth.data, input.session_id, parts);
  return result.ok ? { ok: true, data: safeSession(result.data) }
    : { ok: false, error: failureMessage(result.failure) };
}
