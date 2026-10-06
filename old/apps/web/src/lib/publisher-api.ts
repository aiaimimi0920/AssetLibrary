import "server-only";

import type {
  CreatePackageRequest,
  CreateReleaseRequest,
  OwnedPackage,
  OwnedPackagePage,
  OwnedRelease,
  OwnedReleasePage,
  PublisherMembershipPage,
  UpdatePackageRequest,
  UpdateReleaseRequest,
} from "./publisher-contracts";
import {
  parseMembershipPage,
  parseOwnedPackage,
  parseOwnedPackagePage,
  parseOwnedRelease,
  parseOwnedReleasePage,
} from "./publisher-parser";
import type {
  PublisherModerationCaseDetail,
  PublisherModerationCasePage,
  PublisherModerationCaseView,
} from "./publisher-moderation-contracts";
import {
  parsePublisherModerationCaseDetail,
  parsePublisherModerationCasePage,
  parsePublisherModerationCaseView,
} from "./publisher-moderation-parser";
import type {
  PublisherReleaseWorkspace,
  PublisherSubmissionView,
} from "./publisher-workspace-contracts";
import {
  parsePublisherReleaseWorkspace,
  parsePublisherSubmissionView,
} from "./publisher-workspace-parser";
import type {
  CompletedBrowserPart,
  CreateBrowserUploadRequest,
  PresignBrowserPartRequest,
  PresignedUploadPartResponse,
  UploadRecoveryResponse,
  UploadSessionResponse,
} from "./publisher-upload-contracts";
import {
  parsePresignedUploadPart,
  parseUploadRecovery,
  parseUploadSession,
} from "./publisher-upload-parser";
import type {
  PublisherSigningKey,
  PublisherSigningKeyPage,
  RegisterSigningKeyRequest,
} from "./publisher-signing-key-contracts";
import {
  isCanonicalEd25519PublicKey,
  parsePublisherSigningKey,
  parsePublisherSigningKeyPage,
} from "./publisher-signing-key-parser";

const DEFAULT_API_URL = "http://127.0.0.1:8080";
const REQUEST_TIMEOUT_MS = 5_000;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PublisherApiFailure =
  | "invalid_request"
  | "unauthenticated"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "feature_disabled"
  | "unavailable"
  | "invalid_response";

export type PublisherApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; failure: PublisherApiFailure };

interface PageQuery { cursor?: string; limit?: number }

function apiBaseUrl(): URL {
  const url = new URL(process.env.ASSETLIBRARY_API_URL ?? DEFAULT_API_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || url.hash) {
    throw new Error("Private AssetLibrary API URL must use HTTPS or loopback HTTP");
  }
  return url;
}

function validPage(query: PageQuery): boolean {
  return (query.limit === undefined
      || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100)
    && (query.cursor === undefined
      || query.cursor.length > 0 && query.cursor.length <= 256 && /^[A-Za-z0-9_-]+$/.test(query.cursor));
}

function endpoint(path: string, query?: PageQuery): URL {
  const url = new URL(path, apiBaseUrl());
  if (query?.cursor) url.searchParams.set("cursor", query.cursor);
  if (query?.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  return url;
}

function mapStatus(status: number): PublisherApiFailure {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  if (status === 501) return "feature_disabled";
  return "unavailable";
}

async function request<T>(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token: string,
  parser: (value: unknown) => T,
  query?: PageQuery,
  body?: object,
  idempotencyKey?: string,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<PublisherApiResult<T>> {
  if (token.length < 32 || token.length > 8_192 || /[\u0000-\u001f\u007f]/.test(token)) {
    return { ok: false, failure: "unauthenticated" };
  }
  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token}`,
    };
    if (body) headers["content-type"] = "application/json";
    if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
    const response = await fetch(endpoint(path, query), {
      method,
      cache: "no-store",
      redirect: "error",
      headers,
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { ok: false, failure: mapStatus(response.status) };
    try {
      return { ok: true, data: parser(await response.json()) };
    } catch {
      return { ok: false, failure: "invalid_response" };
    }
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export function listPublisherMemberships(
  token: string,
  query: PageQuery = {},
): Promise<PublisherApiResult<PublisherMembershipPage>> {
  if (!validPage(query)) return Promise.resolve({ ok: false, failure: "invalid_request" });
  return request("GET", "/v1/me/publishers", token, parseMembershipPage, query);
}

export function listOwnedPackages(
  token: string,
  publisherId: string,
  query: PageQuery = {},
): Promise<PublisherApiResult<OwnedPackagePage>> {
  if (!uuidPattern.test(publisherId) || !validPage(query)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/publishers/${publisherId}/packages`, token, parseOwnedPackagePage, query);
}

export function listPublisherSigningKeys(
  token: string,
  publisherId: string,
  query: PageQuery = {},
): Promise<PublisherApiResult<PublisherSigningKeyPage>> {
  if (!uuidPattern.test(publisherId) || !validPage(query)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/publishers/${publisherId}/signing-keys`, token,
    (value) => {
      const page = parsePublisherSigningKeyPage(value);
      if (page.items.some((item) => item.publisher_id !== publisherId)) {
        throw new Error("Signing-key response crossed the requested Publisher boundary");
      }
      return page;
    }, query);
}

export function registerPublisherSigningKey(
  token: string,
  publisherId: string,
  idempotencyKey: string,
  body: RegisterSigningKeyRequest,
): Promise<PublisherApiResult<PublisherSigningKey>> {
  if (!uuidPattern.test(publisherId) || !validKey(idempotencyKey)
    || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(body.key_id)
    || body.algorithm !== "ed25519" || !isCanonicalEd25519PublicKey(body.public_key_base64)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/publishers/${publisherId}/signing-keys`, token,
    (value) => {
      const signingKey = parsePublisherSigningKey(value);
      if (signingKey.publisher_id !== publisherId) {
        throw new Error("Signing-key response crossed the requested Publisher boundary");
      }
      return signingKey;
    }, undefined, body, idempotencyKey);
}

export function revokePublisherSigningKey(
  token: string,
  publisherId: string,
  keyId: string,
  idempotencyKey: string,
  reason: string,
): Promise<PublisherApiResult<PublisherSigningKey>> {
  if (!uuidPattern.test(publisherId) || !/^[a-z0-9][a-z0-9._-]{0,79}$/.test(keyId)
    || !validKey(idempotencyKey) || !validLine(reason, 500)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST",
    `/v1/me/publishers/${publisherId}/signing-keys/${encodeURIComponent(keyId)}/revoke`, token,
    (value) => {
      const signingKey = parsePublisherSigningKey(value);
      if (signingKey.publisher_id !== publisherId || signingKey.key_id !== keyId) {
        throw new Error("Signing-key response crossed the requested key boundary");
      }
      return signingKey;
    }, undefined, { reason }, idempotencyKey);
}

export function listOwnedReleases(
  token: string,
  packageId: string,
  query: PageQuery = {},
): Promise<PublisherApiResult<OwnedReleasePage>> {
  if (!uuidPattern.test(packageId) || !validPage(query)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/packages/${packageId}/releases`, token, parseOwnedReleasePage, query);
}

export function getOwnedPackage(
  token: string,
  packageId: string,
): Promise<PublisherApiResult<OwnedPackage>> {
  if (!uuidPattern.test(packageId)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/packages/${packageId}`, token, parseOwnedPackage);
}

export function getOwnedRelease(
  token: string,
  releaseId: string,
): Promise<PublisherApiResult<OwnedRelease>> {
  if (!uuidPattern.test(releaseId)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/releases/${releaseId}`, token, parseOwnedRelease);
}

export function getPublisherReleaseWorkspace(
  token: string,
  releaseId: string,
): Promise<PublisherApiResult<PublisherReleaseWorkspace>> {
  if (!uuidPattern.test(releaseId)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/releases/${releaseId}/workspace`, token,
    parsePublisherReleaseWorkspace);
}

export function listPublisherModerationCases(
  token: string,
  query: PageQuery = {},
): Promise<PublisherApiResult<PublisherModerationCasePage>> {
  if (!validPage(query)) return Promise.resolve({ ok: false, failure: "invalid_request" });
  return request("GET", "/v1/me/moderation-cases", token, parsePublisherModerationCasePage, query);
}

export function getPublisherModerationCase(
  token: string,
  caseId: string,
): Promise<PublisherApiResult<PublisherModerationCaseDetail>> {
  if (!uuidPattern.test(caseId)) return Promise.resolve({ ok: false, failure: "invalid_request" });
  return request("GET", `/v1/me/moderation-cases/${caseId}`, token, parsePublisherModerationCaseDetail);
}

export function appealPublisherModerationCase(
  token: string,
  caseId: string,
  idempotencyKey: string,
  reason: string,
): Promise<PublisherApiResult<PublisherModerationCaseView>> {
  if (!uuidPattern.test(caseId) || !validKey(idempotencyKey)
    || reason.length < 1 || reason.length > 4_000 || reason.trim() !== reason
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(reason)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/moderation-cases/${caseId}/appeal`, token,
    parsePublisherModerationCaseView, undefined, { reason }, idempotencyKey);
}

export function createPackage(
  token: string,
  publisherId: string,
  idempotencyKey: string,
  body: CreatePackageRequest,
): Promise<PublisherApiResult<OwnedPackage>> {
  if (!uuidPattern.test(publisherId) || !validKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/publishers/${publisherId}/packages`, token,
    parseOwnedPackage, undefined, body, idempotencyKey);
}

export function updatePackage(
  token: string,
  packageId: string,
  idempotencyKey: string,
  body: UpdatePackageRequest,
): Promise<PublisherApiResult<OwnedPackage>> {
  if (!uuidPattern.test(packageId) || !validKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("PATCH", `/v1/me/packages/${packageId}`, token,
    (value) => {
      const ownedPackage = parseOwnedPackage(value);
      if (ownedPackage.id !== packageId) {
        throw new Error("Package response crossed the requested resource boundary");
      }
      return ownedPackage;
    }, undefined, body, idempotencyKey);
}

export function createRelease(
  token: string,
  packageId: string,
  idempotencyKey: string,
  body: CreateReleaseRequest,
): Promise<PublisherApiResult<OwnedRelease>> {
  if (!uuidPattern.test(packageId) || !validKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/packages/${packageId}/releases`, token,
    parseOwnedRelease, undefined, body, idempotencyKey);
}

export function updateRelease(
  token: string,
  releaseId: string,
  idempotencyKey: string,
  body: UpdateReleaseRequest,
): Promise<PublisherApiResult<OwnedRelease>> {
  if (!uuidPattern.test(releaseId) || !validKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("PATCH", `/v1/me/releases/${releaseId}`, token,
    parseOwnedRelease, undefined, body, idempotencyKey);
}

export function submitPublisherRelease(
  token: string,
  releaseId: string,
  idempotencyKey: string,
  artifactId: string,
): Promise<PublisherApiResult<PublisherSubmissionView>> {
  if (!uuidPattern.test(releaseId) || !uuidPattern.test(artifactId) || !validKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/releases/${releaseId}/submissions`, token,
    parsePublisherSubmissionView, undefined, { artifact_id: artifactId }, idempotencyKey);
}

export function createPublisherUploadSession(
  token: string,
  releaseId: string,
  idempotencyKey: string,
  body: CreateBrowserUploadRequest,
): Promise<PublisherApiResult<UploadSessionResponse>> {
  if (!uuidPattern.test(releaseId) || !validKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/releases/${releaseId}/upload-sessions`, token,
    parseUploadSession, undefined, body, idempotencyKey);
}

export function getPublisherUploadSession(
  token: string,
  sessionId: string,
): Promise<PublisherApiResult<UploadRecoveryResponse>> {
  if (!uuidPattern.test(sessionId)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("GET", `/v1/me/upload-sessions/${sessionId}`, token, parseUploadRecovery);
}

export function presignPublisherUploadPart(
  token: string,
  sessionId: string,
  partNumber: number,
  body: PresignBrowserPartRequest,
): Promise<PublisherApiResult<PresignedUploadPartResponse>> {
  if (!uuidPattern.test(sessionId) || !Number.isInteger(partNumber)
    || partNumber < 1 || partNumber > 10_000) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/upload-sessions/${sessionId}/parts/${partNumber}`, token,
    parsePresignedUploadPart, undefined, body);
}

export function completePublisherUploadSession(
  token: string,
  sessionId: string,
  parts: CompletedBrowserPart[],
): Promise<PublisherApiResult<UploadSessionResponse>> {
  if (!uuidPattern.test(sessionId)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request("POST", `/v1/me/upload-sessions/${sessionId}/complete`, token,
    parseUploadSession, undefined, { parts }, undefined, 30_000);
}

function validKey(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}

function validLine(value: string, maximum: number): boolean {
  return value.length >= 1 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}
