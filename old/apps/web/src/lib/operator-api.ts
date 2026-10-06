import "server-only";

import type {
  DecideReviewRequest,
  OperatorReviewQueuePage,
  OperatorSubmissionDetail,
  SubmissionView,
} from "./operator-contracts";
import type {
  ModerationActionView,
  ModerationCaseView,
  OperatorModerationCaseDetail,
  OperatorModerationQueuePage,
  ProposeModerationActionRequest,
  ResolveModerationRequest,
} from "./operator-moderation-contracts";
import {
  parseModerationActionView,
  parseModerationCaseView,
  parseOperatorModerationCaseDetail,
  parseOperatorModerationQueuePage,
} from "./operator-moderation-parser";
import {
  parseOperatorReviewQueuePage,
  parseOperatorSubmissionDetail,
  parseReviewDecisionView,
} from "./operator-parser";

const DEFAULT_API_URL = "http://127.0.0.1:8080";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type OperatorApiFailure =
  | "invalid_request" | "unauthenticated" | "forbidden" | "not_found"
  | "conflict" | "unavailable" | "invalid_response";
export type OperatorApiResult<T> = { ok: true; data: T } | { ok: false; failure: OperatorApiFailure };
interface PageQuery { cursor?: string; limit?: number }

function apiBaseUrl(): URL {
  const url = new URL(process.env.ASSETLIBRARY_API_URL ?? DEFAULT_API_URL);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && local))
    || url.username || url.password || url.hash) {
    throw new Error("Operator API URL must use HTTPS or loopback HTTP");
  }
  return url;
}

function mapStatus(status: number): OperatorApiFailure {
  if (status === 400) return "invalid_request";
  if (status === 401) return "unauthenticated";
  if (status === 403) return "forbidden";
  if (status === 404) return "not_found";
  if (status === 409) return "conflict";
  return "unavailable";
}

async function request<T>(path: string, token: string, parser: (value: unknown) => T,
  init: { method?: "GET" | "POST"; body?: object; idempotencyKey?: string } = {}): Promise<OperatorApiResult<T>> {
  if (token.length < 32 || token.length > 8_192 || /[\u0000-\u001f\u007f]/.test(token)) {
    return { ok: false, failure: "unauthenticated" };
  }
  try {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${token}` };
    if (init.body) headers["content-type"] = "application/json";
    if (init.idempotencyKey) headers["idempotency-key"] = init.idempotencyKey;
    const response = await fetch(new URL(path, apiBaseUrl()), {
      method: init.method ?? "GET",
      cache: "no-store",
      redirect: "error",
      headers,
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) return { ok: false, failure: mapStatus(response.status) };
    try { return { ok: true, data: parser(await response.json()) }; }
    catch { return { ok: false, failure: "invalid_response" }; }
  } catch {
    return { ok: false, failure: "unavailable" };
  }
}

export function listOperatorReviewQueue(token: string, query: PageQuery = {}): Promise<OperatorApiResult<OperatorReviewQueuePage>> {
  const valid = (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100)
    && (query.cursor === undefined || query.cursor.length > 0 && query.cursor.length <= 256
      && /^[A-Za-z0-9_-]+$/.test(query.cursor));
  if (!valid) return Promise.resolve({ ok: false, failure: "invalid_request" });
  const url = new URL("/v1/internal/review-queue", "http://operator.invalid");
  if (query.cursor) url.searchParams.set("cursor", query.cursor);
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  return request(`${url.pathname}${url.search}`, token, parseOperatorReviewQueuePage);
}

export function getOperatorSubmission(token: string, submissionId: string): Promise<OperatorApiResult<OperatorSubmissionDetail>> {
  if (!uuidPattern.test(submissionId)) return Promise.resolve({ ok: false, failure: "invalid_request" });
  return request(`/v1/internal/submissions/${submissionId}`, token, parseOperatorSubmissionDetail);
}

export function decideOperatorSubmission(token: string, submissionId: string, idempotencyKey: string,
  body: DecideReviewRequest): Promise<OperatorApiResult<SubmissionView>> {
  if (!uuidPattern.test(submissionId) || idempotencyKey.length < 8 || idempotencyKey.length > 200
    || !/^[\x21-\x7e]+$/.test(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(`/v1/internal/submissions/${submissionId}/reviews`, token,
    parseReviewDecisionView, { method: "POST", body, idempotencyKey });
}

export function listOperatorModerationCases(token: string, query: PageQuery = {}): Promise<OperatorApiResult<OperatorModerationQueuePage>> {
  const valid = (query.limit === undefined || Number.isInteger(query.limit) && query.limit >= 1 && query.limit <= 100)
    && (query.cursor === undefined || query.cursor.length > 0 && query.cursor.length <= 256
      && /^[A-Za-z0-9_-]+$/.test(query.cursor));
  if (!valid) return Promise.resolve({ ok: false, failure: "invalid_request" });
  const url = new URL("/v1/internal/moderation-cases", "http://operator.invalid");
  if (query.cursor) url.searchParams.set("cursor", query.cursor);
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  return request(`${url.pathname}${url.search}`, token, parseOperatorModerationQueuePage);
}

export function getOperatorModerationCase(token: string, caseId: string): Promise<OperatorApiResult<OperatorModerationCaseDetail>> {
  if (!uuidPattern.test(caseId)) return Promise.resolve({ ok: false, failure: "invalid_request" });
  return request(`/v1/internal/moderation-cases/${caseId}`, token, parseOperatorModerationCaseDetail);
}

export function proposeOperatorModerationAction(token: string, caseId: string, idempotencyKey: string,
  body: ProposeModerationActionRequest): Promise<OperatorApiResult<ModerationActionView>> {
  if (!uuidPattern.test(caseId) || !validIdempotencyKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(`/v1/internal/moderation-cases/${caseId}/actions`, token,
    parseModerationActionView, { method: "POST", body, idempotencyKey });
}

export function approveOperatorModerationAction(token: string, actionId: string,
  idempotencyKey: string): Promise<OperatorApiResult<ModerationActionView>> {
  if (!uuidPattern.test(actionId) || !validIdempotencyKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(`/v1/internal/moderation-actions/${actionId}/approve`, token,
    parseModerationActionView, { method: "POST", idempotencyKey });
}

export function resolveOperatorModerationCase(token: string, caseId: string, idempotencyKey: string,
  body: ResolveModerationRequest): Promise<OperatorApiResult<ModerationCaseView>> {
  if (!uuidPattern.test(caseId) || !validIdempotencyKey(idempotencyKey)) {
    return Promise.resolve({ ok: false, failure: "invalid_request" });
  }
  return request(`/v1/internal/moderation-cases/${caseId}/resolve`, token,
    parseModerationCaseView, { method: "POST", body, idempotencyKey });
}

function validIdempotencyKey(value: string): boolean {
  return value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}
