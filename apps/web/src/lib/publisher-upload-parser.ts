import type {
  PresignedUploadPartResponse,
  UploadRecoveryResponse,
  UploadSessionResponse,
} from "./publisher-upload-contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const checksum = /^[A-Za-z0-9+/]{43}=$/;
const safeHeader = /^(?:content-length|content-type|x-amz-[a-z0-9-]{1,80})$/;
const DEFAULT_UPLOAD_ORIGIN = "http://127.0.0.1:9100";

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function integer(value: unknown, minimum: number, maximum: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}

function safeLine(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function safeUploadUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 8_192) return false;
  try {
    const url = new URL(value);
    const loopback = url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    const safeProtocol = url.protocol === "https:" || url.protocol === "http:" && loopback;
    const configured = (process.env.ASSETLIBRARY_UPLOAD_ORIGINS ?? DEFAULT_UPLOAD_ORIGIN)
      .split(",").map((item) => item.trim()).filter(Boolean);
    if (!safeProtocol || url.username || url.password || url.hash || configured.length > 8) return false;
    return configured.some((candidate) => {
      try {
        const allowed = new URL(candidate);
        return allowed.origin === candidate && allowed.origin === url.origin
          && (allowed.protocol === "https:" || allowed.protocol === "http:"
            && ["127.0.0.1", "[::1]"].includes(allowed.hostname));
      } catch { return false; }
    });
  } catch { return false; }
}

export function parseUploadSession(value: unknown): UploadSessionResponse {
  const keys = ["id", "release_id", "artifact_id", "object_key", "part_size_bytes", "max_parts",
    "expires_at_epoch_seconds", "status", "expected_digest"];
  if (!exact(value, keys) || ![value.id, value.release_id, value.artifact_id]
    .every((item) => typeof item === "string" && uuid.test(item))
    || !safeLine(value.object_key, 1_024) || !integer(value.part_size_bytes, 5_242_880, 2_147_483_648)
    || !integer(value.max_parts, 1, 10_000)
    || !integer(value.expires_at_epoch_seconds, 1, Number.MAX_SAFE_INTEGER)
    || !["pending_upload", "uploaded"].includes(String(value.status))
    || !exact(value.expected_digest, ["algorithm", "value"])
    || value.expected_digest.algorithm !== "sha256" || typeof value.expected_digest.value !== "string"
    || !digest.test(value.expected_digest.value)) throw new Error("Invalid upload session response");
  return value as unknown as UploadSessionResponse;
}

export function parsePresignedUploadPart(value: unknown): PresignedUploadPartResponse {
  const keys = ["part_number", "method", "url", "headers", "expires_in_seconds"];
  if (!exact(value, keys) || !integer(value.part_number, 1, 10_000) || value.method !== "PUT"
    || !safeUploadUrl(value.url) || !record(value.headers) || Object.keys(value.headers).length > 16
    || !integer(value.expires_in_seconds, 1, 3_600)) throw new Error("Invalid presigned upload response");
  for (const [name, headerValue] of Object.entries(value.headers)) {
    if (!safeHeader.test(name.toLowerCase()) || !safeLine(headerValue, 1_000)) {
      throw new Error("Invalid presigned upload header");
    }
  }
  return value as unknown as PresignedUploadPartResponse;
}

export function parseUploadRecovery(value: unknown): UploadRecoveryResponse {
  const keys = ["id", "release_id", "artifact_id", "part_size_bytes", "max_parts", "size_bytes",
    "expires_at_epoch_seconds", "status", "expected_digest", "uploaded_parts"];
  if (!exact(value, keys) || ![value.id, value.release_id, value.artifact_id]
    .every((item) => typeof item === "string" && uuid.test(item))
    || !integer(value.part_size_bytes, 5_242_880, 2_147_483_648)
    || !integer(value.max_parts, 1, 10_000) || !integer(value.size_bytes, 1, 2_147_483_648)
    || !integer(value.expires_at_epoch_seconds, 1, Number.MAX_SAFE_INTEGER)
    || !["pending_upload", "uploaded"].includes(String(value.status))
    || !exact(value.expected_digest, ["algorithm", "value"])
    || value.expected_digest.algorithm !== "sha256" || typeof value.expected_digest.value !== "string"
    || !digest.test(value.expected_digest.value) || !Array.isArray(value.uploaded_parts)
    || value.uploaded_parts.length > Number(value.max_parts)) {
    throw new Error("Invalid upload recovery response");
  }
  let previous = 0;
  for (const part of value.uploaded_parts) {
    if (!exact(part, ["part_number", "etag", "checksum_sha256_base64", "size_bytes"])
      || !integer(part.part_number, previous + 1, Number(value.max_parts))
      || !safeLine(part.etag, 200) || typeof part.checksum_sha256_base64 !== "string"
      || !checksum.test(part.checksum_sha256_base64)
      || !integer(part.size_bytes, 1, Number(value.part_size_bytes))) {
      throw new Error("Invalid recovered upload part");
    }
    previous = Number(part.part_number);
  }
  return value as unknown as UploadRecoveryResponse;
}
