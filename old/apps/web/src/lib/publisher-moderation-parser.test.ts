import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  parsePublisherModerationCaseDetail,
  parsePublisherModerationCasePage,
} from "./publisher-moderation-parser";

function fixture(name: string): unknown {
  const path = fileURLToPath(new URL(`../../../../contracts/fixtures/${name}`, import.meta.url));
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

describe("Publisher moderation runtime contracts", () => {
  it("parses the shared scoped case fixtures", () => {
    expect(parsePublisherModerationCasePage(
      fixture("publisher-moderation-case-page.v1.json"),
    ).items[0]?.status).toBe("actioned");
    expect(parsePublisherModerationCaseDetail(
      fixture("publisher-moderation-case-detail.v1.json"),
    ).can_appeal).toBe(true);
  });

  it("rejects internal report fields and inconsistent appeal state", () => {
    const detail = fixture("publisher-moderation-case-detail.v1.json") as Record<string, unknown>;
    detail.evidence_urls = ["https://internal.invalid/evidence"];
    expect(() => parsePublisherModerationCaseDetail(detail)).toThrow("Invalid publisher moderation detail");

    const inconsistent = fixture("publisher-moderation-case-detail.v1.json") as Record<string, unknown>;
    inconsistent.can_appeal = false;
    expect(() => parsePublisherModerationCaseDetail(inconsistent)).toThrow("Inconsistent publisher moderation state");

    const malformedTime = fixture("publisher-moderation-case-detail.v1.json") as {
      item: { action: { applied_at: string } };
    };
    malformedTime.item.action.applied_at = "2026-09-04";
    expect(() => parsePublisherModerationCaseDetail(malformedTime))
      .toThrow("Invalid publisher moderation action contract");
  });
});
