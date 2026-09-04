import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseOperatorReviewQueuePage, parseOperatorSubmissionDetail } from "./operator-parser";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/${name}`, import.meta.url), "utf8"));
}

describe("operator response contracts", () => {
  it("parses the shared queue and detail fixtures", () => {
    const queue = parseOperatorReviewQueuePage(fixture("operator-review-queue-page.v1.json"));
    const detail = parseOperatorSubmissionDetail(fixture("operator-submission-detail.v1.json"));
    expect(queue.items[0]?.package.slug).toBe("neuro-capability");
    expect(detail.evidence.digest).toMatch(/^sha256:/);
    expect(detail.reviews[0]?.decision).toBe("approved");
  });

  it("rejects internal storage fields and malformed evidence", () => {
    const detail = fixture("operator-submission-detail.v1.json") as Record<string, unknown>;
    expect(() => parseOperatorSubmissionDetail({ ...detail, object_key: "quarantine/private.zip" })).toThrow();
    const evidence = detail.evidence as Record<string, unknown>;
    expect(() => parseOperatorSubmissionDetail({
      ...detail,
      evidence: { ...evidence, digest: "sha256:UPPERCASE" },
    })).toThrow();
  });

  it("rejects unknown fields nested inside a review finding", () => {
    const detail = fixture("operator-submission-detail.v1.json") as Record<string, unknown>;
    const reviews = detail.reviews as Array<Record<string, unknown>>;
    const findings = [{ code: "safe", severity: "info", message: "ok", scan_evidence: {} }];
    expect(() => parseOperatorSubmissionDetail({
      ...detail,
      reviews: [{ ...reviews[0], findings }],
    })).toThrow();
  });

  it("rejects review history from a different submission revision", () => {
    const detail = fixture("operator-submission-detail.v1.json") as Record<string, unknown>;
    const reviews = detail.reviews as Array<Record<string, unknown>>;
    expect(() => parseOperatorSubmissionDetail({
      ...detail,
      reviews: [{ ...reviews[0], revision: 1 }],
    })).toThrow(/current submission revision/);
  });
});
