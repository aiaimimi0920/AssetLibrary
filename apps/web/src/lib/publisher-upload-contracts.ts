export interface UploadSessionResponse {
  id: string;
  release_id: string;
  artifact_id: string;
  object_key: string;
  part_size_bytes: number;
  max_parts: number;
  expires_at_epoch_seconds: number;
  status: "pending_upload" | "uploaded";
  expected_digest: { algorithm: "sha256"; value: string };
}

export interface PresignedUploadPartResponse {
  part_number: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_in_seconds: number;
}

export interface BrowserUploadSession {
  id: string;
  artifact_id: string;
  part_size_bytes: number;
  max_parts: number;
  expires_at_epoch_seconds: number;
  status: "pending_upload" | "uploaded";
  expected_digest: string;
}

export interface RecoveredUploadPart extends CompletedBrowserPart {
  size_bytes: number;
}

export interface UploadRecoveryResponse {
  id: string;
  release_id: string;
  artifact_id: string;
  part_size_bytes: number;
  max_parts: number;
  size_bytes: number;
  expires_at_epoch_seconds: number;
  status: "pending_upload" | "uploaded";
  expected_digest: { algorithm: "sha256"; value: string };
  uploaded_parts: RecoveredUploadPart[];
}

export interface BrowserUploadRecovery extends BrowserUploadSession {
  release_id: string;
  size_bytes: number;
  uploaded_parts: RecoveredUploadPart[];
}

export interface BrowserUploadPart {
  part_number: number;
  method: "PUT";
  url: string;
  headers: Record<string, string>;
  expires_in_seconds: number;
}

export interface CompletedBrowserPart {
  part_number: number;
  etag: string;
  checksum_sha256_base64: string;
}

export interface CreateBrowserUploadRequest {
  file_name: string;
  media_type: "application/zip" | "application/x-zip-compressed" | "application/octet-stream";
  size_bytes: number;
  part_size_bytes: number;
  part_count: number;
  expected_digest: { algorithm: "sha256"; value: string };
}

export interface PresignBrowserPartRequest {
  size_bytes: number;
  checksum_sha256_base64: string;
}

export type UploadActionResult<T> = { ok: true; data: T } | { ok: false; error: string };
