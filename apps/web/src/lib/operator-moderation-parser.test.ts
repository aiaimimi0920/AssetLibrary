import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parseOperatorModerationCaseDetail,
  parseOperatorModerationQueuePage,
} from "./operator-moderation-parser";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../../contracts/fixtures/${name}`, import.meta.url), "utf8"));
}

describe("operator moderation response contracts", () => {
  it("parses the shared queue and detail fixtures", () => {
    const queue = parseOperatorModerationQueuePage(fixture("operator-moderation-queue-page.v1.json"));
    const detail = parseOperatorModerationCaseDetail(fixture("operator-moderation-case-detail.v1.json"));
    expect(queue.items[0]?.status).toBe("appealed");
    expect(detail.actions[0]?.target_type).toBe("release");
    expect(detail.can_resolve).toBe(true);
  });

  it("rejects principal, object-store, and raw scanner fields", () => {
    const detail = fixture("operator-moderation-case-detail.v1.json") as Record<string, unknown>;
    for (const extra of ["reporter_subject", "object_key", "scan_evidence"]) {
      expect(() => parseOperatorModerationCaseDetail({ ...detail, [extra]: "forbidden" })).toThrow();
    }
  });

  it("rejects inconsistent appeal state and multiple actions", () => {
    const detail = fixture("operator-moderation-case-detail.v1.json") as Record<string, unknown>;
    const actions = detail.actions as unknown[];
    expect(() => parseOperatorModerationCaseDetail({ ...detail, can_resolve: false })).toThrow(/state/);
    expect(() => parseOperatorModerationCaseDetail({ ...detail, actions: [...actions, actions[0]] })).toThrow();
  });
});
