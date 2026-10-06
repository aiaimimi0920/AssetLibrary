import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  parsePublisherReleaseWorkspace,
  parsePublisherSubmissionView,
} from "./publisher-workspace-parser";

const workspace = JSON.parse(readFileSync(new URL(
  "../../../../contracts/fixtures/publisher-release-workspace.v1.json",
  import.meta.url,
), "utf8"));

describe("Publisher release workspace parser", () => {
  it("accepts the bounded de-identified workspace fixture", () => {
    expect(parsePublisherReleaseWorkspace(workspace)).toMatchObject({
      schema_version: "1.0",
      artifacts: [{ status: "verified", file_name: "neuro-painter-1.0.0.zip" }],
      feedback: [{ decision: "needs_changes" }],
    });
  });

  it("rejects storage keys and reviewer identities at the projection boundary", () => {
    const withObjectKey = structuredClone(workspace);
    withObjectKey.artifacts[0].object_key = "quarantine/private/object.zip";
    expect(() => parsePublisherReleaseWorkspace(withObjectKey)).toThrow();

    const withReviewer = structuredClone(workspace);
    withReviewer.feedback[0].reviewer_subject = "private-reviewer-subject";
    expect(() => parsePublisherReleaseWorkspace(withReviewer)).toThrow();
  });

  it("rejects incomplete verification and date-only timestamps", () => {
    const incomplete = structuredClone(workspace);
    incomplete.artifacts[0].scanner_version = null;
    expect(() => parsePublisherReleaseWorkspace(incomplete)).toThrow();

    const dateOnly = structuredClone(workspace);
    dateOnly.feedback[0].decided_at = "2026-09-03";
    expect(() => parsePublisherReleaseWorkspace(dateOnly)).toThrow();
  });

  it("parses the submission mutation projection without internal policy evidence", () => {
    expect(parsePublisherSubmissionView({
      id: "44444444-4444-4444-8444-444444444444",
      release_id: workspace.release_id,
      artifact_id: workspace.artifacts[0].id,
      revision: 2,
      status: "in_review",
      required_approvals: 2,
      approval_count: 0,
      scanner_version: "asset-scanner-1",
      rule_version: "rules-2026-09",
    })).toMatchObject({ status: "in_review", revision: 2 });
  });
});
