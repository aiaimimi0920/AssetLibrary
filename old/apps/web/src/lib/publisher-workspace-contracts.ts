export type ArtifactStatus =
  | "pending_upload" | "uploaded" | "scanning" | "verified" | "quarantined" | "deleted";
export type SubmissionStatus =
  | "in_review" | "changes_requested" | "approved" | "rejected" | "withdrawn";
export type ReviewDecision = "approved" | "rejected" | "needs_changes";

export interface PublisherArtifactSummary {
  id: string;
  status: ArtifactStatus;
  file_name: string;
  size_bytes: number;
  media_type: string;
  expected_digest: string | null;
  verified_digest: string | null;
  scanner_version: string | null;
  rule_version: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PublisherSubmissionSummary {
  id: string;
  artifact_id: string;
  revision: number;
  status: SubmissionStatus;
  required_approvals: 1 | 2;
  approval_count: number;
  submitted_at: string | null;
  updated_at: string;
}

export interface PublisherReviewFeedback {
  revision: number;
  decision: ReviewDecision;
  reason: string;
  findings: Array<{ code: string; severity: "info" | "warning" | "error"; message: string }>;
  decided_at: string;
}

export interface PublisherReleaseWorkspace {
  schema_version: "1.0";
  release_id: string;
  artifacts: PublisherArtifactSummary[];
  artifacts_truncated: boolean;
  submission: PublisherSubmissionSummary | null;
  feedback: PublisherReviewFeedback[];
  feedback_truncated: boolean;
  can_upload: boolean;
}

export interface PublisherSubmissionView {
  id: string;
  release_id: string;
  artifact_id: string;
  revision: number;
  status: SubmissionStatus;
  required_approvals: 1 | 2;
  approval_count: number;
  scanner_version: string;
  rule_version: string;
}
