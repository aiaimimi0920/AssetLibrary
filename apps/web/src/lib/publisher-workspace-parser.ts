import type {
  PublisherArtifactSummary,
  PublisherReleaseWorkspace,
  PublisherReviewFeedback,
  PublisherSubmissionSummary,
  PublisherSubmissionView,
} from "./publisher-workspace-contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^sha256:[a-f0-9]{64}$/;
const fileName = /^[A-Za-z0-9][A-Za-z0-9._-]{0,235}\.zip$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const artifactStatuses = ["pending_upload", "uploaded", "scanning", "verified", "quarantined", "deleted"];
const submissionStatuses = ["in_review", "changes_requested", "approved", "rejected", "withdrawn"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function line(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function multiline(value: unknown, minimum: number, maximum: number): value is string {
  return typeof value === "string" && value.length >= minimum && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function dateTime(value: unknown): value is string {
  return line(value, 1, 64) && rfc3339.test(value) && Number.isFinite(Date.parse(value));
}

function nullable<T>(value: unknown, predicate: (candidate: unknown) => candidate is T): value is T | null {
  return value === null || predicate(value);
}

function parseArtifact(value: unknown): PublisherArtifactSummary {
  const keys = ["id", "status", "file_name", "size_bytes", "media_type", "expected_digest",
    "verified_digest", "scanner_version", "rule_version", "verified_at", "created_at", "updated_at"];
  if (!exact(value, keys) || typeof value.id !== "string" || !uuid.test(value.id)
    || !artifactStatuses.includes(String(value.status)) || typeof value.file_name !== "string"
    || !fileName.test(value.file_name) || !Number.isSafeInteger(value.size_bytes) || Number(value.size_bytes) < 1
    || Number(value.size_bytes) > 2_147_483_648 || !line(value.media_type, 1, 200)
    || !nullable(value.expected_digest, (item): item is string => typeof item === "string" && digest.test(item))
    || !nullable(value.verified_digest, (item): item is string => typeof item === "string" && digest.test(item))
    || !nullable(value.scanner_version, (item): item is string => line(item, 1, 100))
    || !nullable(value.rule_version, (item): item is string => line(item, 1, 100))
    || !nullable(value.verified_at, dateTime) || !dateTime(value.created_at) || !dateTime(value.updated_at)
    || value.status === "verified" && (value.verified_digest === null || value.scanner_version === null
      || value.rule_version === null || value.verified_at === null)) {
    throw new Error("Invalid Publisher artifact summary");
  }
  return value as unknown as PublisherArtifactSummary;
}

function parseSubmission(value: unknown): PublisherSubmissionSummary | null {
  if (value === null) return null;
  const keys = ["id", "artifact_id", "revision", "status", "required_approvals", "approval_count",
    "submitted_at", "updated_at"];
  if (!exact(value, keys) || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.artifact_id !== "string" || !uuid.test(value.artifact_id)
    || !Number.isInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 10_000
    || !submissionStatuses.includes(String(value.status)) || ![1, 2].includes(Number(value.required_approvals))
    || !Number.isInteger(value.approval_count) || Number(value.approval_count) < 0
    || Number(value.approval_count) > Number(value.required_approvals)
    || !nullable(value.submitted_at, dateTime) || !dateTime(value.updated_at)) {
    throw new Error("Invalid Publisher submission summary");
  }
  return value as unknown as PublisherSubmissionSummary;
}

function parseFeedback(value: unknown): PublisherReviewFeedback {
  if (!exact(value, ["revision", "decision", "reason", "findings", "decided_at"])
    || !Number.isInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 10_000
    || !["approved", "rejected", "needs_changes"].includes(String(value.decision))
    || !multiline(value.reason, 0, 4_000) || !Array.isArray(value.findings) || value.findings.length > 100
    || !dateTime(value.decided_at)) throw new Error("Invalid Publisher review feedback");
  for (const finding of value.findings) {
    if (!exact(finding, ["code", "severity", "message"]) || !line(finding.code, 1, 100)
      || !["info", "warning", "error"].includes(String(finding.severity))
      || !multiline(finding.message, 1, 2_000)) throw new Error("Invalid Publisher review finding");
  }
  return value as unknown as PublisherReviewFeedback;
}

export function parsePublisherReleaseWorkspace(value: unknown): PublisherReleaseWorkspace {
  const keys = ["schema_version", "release_id", "artifacts", "artifacts_truncated", "submission",
    "feedback", "feedback_truncated", "can_upload"];
  if (!exact(value, keys) || value.schema_version !== "1.0"
    || typeof value.release_id !== "string" || !uuid.test(value.release_id)
    || !Array.isArray(value.artifacts) || value.artifacts.length > 100
    || typeof value.artifacts_truncated !== "boolean" || !Array.isArray(value.feedback)
    || value.feedback.length > 100 || typeof value.feedback_truncated !== "boolean"
    || typeof value.can_upload !== "boolean") throw new Error("Invalid Publisher release workspace");
  return { schema_version: "1.0", release_id: value.release_id,
    artifacts: value.artifacts.map(parseArtifact), artifacts_truncated: value.artifacts_truncated,
    submission: parseSubmission(value.submission), feedback: value.feedback.map(parseFeedback),
    feedback_truncated: value.feedback_truncated, can_upload: value.can_upload };
}

export function parsePublisherSubmissionView(value: unknown): PublisherSubmissionView {
  const keys = ["id", "release_id", "artifact_id", "revision", "status", "required_approvals",
    "approval_count", "scanner_version", "rule_version"];
  if (!exact(value, keys) || ![value.id, value.release_id, value.artifact_id]
    .every((item) => typeof item === "string" && uuid.test(item))
    || !Number.isInteger(value.revision) || Number(value.revision) < 1 || Number(value.revision) > 10_000
    || !submissionStatuses.includes(String(value.status)) || ![1, 2].includes(Number(value.required_approvals))
    || !Number.isInteger(value.approval_count) || Number(value.approval_count) < 0
    || Number(value.approval_count) > Number(value.required_approvals)
    || !line(value.scanner_version, 1, 100) || !line(value.rule_version, 1, 100)) {
    throw new Error("Invalid Publisher submission view");
  }
  return value as unknown as PublisherSubmissionView;
}
