import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  approveOperatorModerationAction,
  decideOperatorSubmission,
  getOperatorModerationCase,
  getOperatorSubmission,
  listOperatorModerationCases,
  listOperatorReviewQueue,
  proposeOperatorModerationAction,
  resolveOperatorModerationCase,
} from "./operator-api";

vi.mock("server-only", () => ({}));

const token = "operator-access-token-that-is-long-enough";
const submissionId = "44444444-4444-4444-8444-444444444444";
const queue = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/operator-review-queue-page.v1.json", import.meta.url,
), "utf8"));
const detail = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/operator-submission-detail.v1.json", import.meta.url,
), "utf8"));
const moderationQueue = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/operator-moderation-queue-page.v1.json", import.meta.url,
), "utf8"));
const moderationDetail = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/operator-moderation-case-detail.v1.json", import.meta.url,
), "utf8"));

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("Operator API server client", () => {
  it("keeps bearer access server-side and requests no-store pages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(queue), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(detail), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("ASSETLIBRARY_API_URL", "https://api.assets.example/base/");
    await expect(listOperatorReviewQueue(token, { limit: 30 })).resolves.toMatchObject({ ok: true });
    await expect(getOperatorSubmission(token, submissionId)).resolves.toMatchObject({
      ok: true, data: { can_review: true },
    });
    expect((fetchMock.mock.calls[0]?.[0] as URL).href)
      .toBe("https://api.assets.example/v1/internal/review-queue?limit=30");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      cache: "no-store", redirect: "error", headers: { authorization: `Bearer ${token}` },
    });
  });

  it("posts bounded decisions with idempotency", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      review_id: "66666666-6666-4666-8666-666666666666",
      submission: detail.item.submission,
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const result = await decideOperatorSubmission(token, submissionId, "review-key-123", {
      decision: "needs_changes", reason: "Declare the permission.", findings: [],
    });
    expect(result).toMatchObject({ ok: true, data: { id: submissionId } });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "idempotency-key": "review-key-123" },
    });
  });

  it("rejects invalid local inputs before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getOperatorSubmission(token, "not-a-uuid"))
      .resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(listOperatorReviewQueue(token, { limit: 0 }))
      .resolves.toEqual({ ok: false, failure: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reads private moderation projections and posts all operator transitions", async () => {
    const action = moderationDetail.actions[0];
    const caseView = {
      id: moderationDetail.item.id,
      package_id: moderationDetail.item.package.id,
      release_id: moderationDetail.item.release.id,
      status: "resolved",
    };
    const actionView = {
      id: action.id,
      case_id: moderationDetail.item.id,
      action: action.action,
      target_type: action.target_type,
      target_ref: action.target_ref,
      status: action.status,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(moderationQueue), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(moderationDetail), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(actionView), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(actionView), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(caseView), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const caseId = moderationDetail.item.id;
    await expect(listOperatorModerationCases(token, { limit: 25 })).resolves.toMatchObject({ ok: true });
    await expect(getOperatorModerationCase(token, caseId)).resolves.toMatchObject({ ok: true });
    await expect(proposeOperatorModerationAction(token, caseId, "propose-key", {
      action: "yank", target_type: "release", target_ref: moderationDetail.item.release.id, reason: "Policy violation.",
    })).resolves.toMatchObject({ ok: true });
    await expect(approveOperatorModerationAction(token, action.id, "approve-key")).resolves.toMatchObject({ ok: true });
    await expect(resolveOperatorModerationCase(token, caseId, "resolve-key", {
      resolution: "upheld", reason: "Evidence remains valid.",
    })).resolves.toMatchObject({ ok: true });
    expect((fetchMock.mock.calls[0]?.[0] as URL).href)
      .toBe("http://127.0.0.1:8080/v1/internal/moderation-cases?limit=25");
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      method: "POST", headers: { "idempotency-key": "propose-key" },
    });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      method: "POST", headers: { "idempotency-key": "approve-key" },
    });
  });

  it("rejects malformed moderation identifiers before fetch", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(getOperatorModerationCase(token, "not-a-uuid"))
      .resolves.toEqual({ ok: false, failure: "invalid_request" });
    await expect(listOperatorModerationCases(token, { limit: 101 }))
      .resolves.toEqual({ ok: false, failure: "invalid_request" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
