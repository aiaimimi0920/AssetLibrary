const PREFIX = "assetlibrary.upload.v1.";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,235}\.zip$/;
const mediaTypes = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];

export interface UploadResumeDescriptor {
  version: 1;
  release_id: string;
  session_id: string;
  artifact_id: string;
  file_name: string;
  media_type: string;
  size_bytes: number;
  part_size_bytes: number;
  part_count: number;
  expires_at_epoch_seconds: number;
  expected_digest: string;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

function key(releaseId: string): string {
  return `${PREFIX}${releaseId}`;
}

function valid(value: unknown, releaseId: string): value is UploadResumeDescriptor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  const keys = ["version", "release_id", "session_id", "artifact_id", "file_name", "media_type",
    "size_bytes", "part_size_bytes", "part_count", "expires_at_epoch_seconds", "expected_digest"];
  return Object.keys(item).length === keys.length && keys.every((name) => Object.hasOwn(item, name))
    && item.version === 1 && item.release_id === releaseId && uuid.test(releaseId)
    && typeof item.session_id === "string" && uuid.test(item.session_id)
    && typeof item.artifact_id === "string" && uuid.test(item.artifact_id)
    && typeof item.file_name === "string" && fileName.test(item.file_name)
    && typeof item.media_type === "string" && mediaTypes.includes(item.media_type)
    && Number.isSafeInteger(item.size_bytes) && Number(item.size_bytes) >= 1
    && Number(item.size_bytes) <= 2_147_483_648
    && item.part_size_bytes === 8_388_608
    && Number.isSafeInteger(item.part_count) && Number(item.part_count) >= 1
    && Number(item.part_count) <= 256
    && item.part_count === Math.ceil(Number(item.size_bytes) / Number(item.part_size_bytes))
    && Number.isSafeInteger(item.expires_at_epoch_seconds)
    && Number(item.expires_at_epoch_seconds) > Math.floor(Date.now() / 1_000)
    && typeof item.expected_digest === "string" && digest.test(item.expected_digest);
}

export function readUploadResume(releaseId: string): UploadResumeDescriptor | null {
  const target = storage();
  if (!target) return null;
  try {
    const raw = target.getItem(key(releaseId));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (valid(parsed, releaseId)) return parsed;
    target.removeItem(key(releaseId));
  } catch {
    try { target.removeItem(key(releaseId)); } catch { /* storage is optional */ }
  }
  return null;
}

export function writeUploadResume(value: UploadResumeDescriptor): void {
  if (!valid(value, value.release_id)) return;
  try { storage()?.setItem(key(value.release_id), JSON.stringify(value)); } catch { /* storage is optional */ }
}

export function clearUploadResume(releaseId: string): void {
  try { storage()?.removeItem(key(releaseId)); } catch { /* storage is optional */ }
}
