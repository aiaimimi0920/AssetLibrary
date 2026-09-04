import type { PackageKind, PublisherSummary } from "./contracts";

export type SubmissionStatus =
  | "in_review"
  | "changes_requested"
  | "approved"
  | "rejected"
  | "withdrawn";
export type ReviewDecision = "approved" | "rejected" | "needs_changes";
export type FindingSeverity = "info" | "warning" | "error";

export interface SubmissionView {
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

export interface OperatorReviewPackage {
  id: string;
  slug: string;
  name: string;
  kind: PackageKind;
  summary: string;
  publisher: PublisherSummary;
}

export interface OperatorReviewQueueItem {
  submission: SubmissionView;
  package: OperatorReviewPackage;
  release_version: string;
  submitted_at: string;
  updated_at: string;
}

export interface OperatorReviewQueuePage {
  schema_version: "1.0";
  items: OperatorReviewQueueItem[];
  next_cursor: string | null;
}

export interface ProductCompatibility {
  name: "loom" | "hook";
  version_requirement: string;
}

export interface ReviewFinding {
  code: string;
  severity: FindingSeverity;
  message: string;
}

export interface DecideReviewRequest {
  decision: ReviewDecision;
  reason: string;
  findings: ReviewFinding[];
}

export interface OperatorReviewRecord extends DecideReviewRequest {
  id: string;
  revision: number;
  decided_at: string;
}

export interface OperatorSubmissionDetail {
  schema_version: "1.0";
  item: OperatorReviewQueueItem;
  compatibility: { products: ProductCompatibility[] };
  permissions: string[];
  evidence: {
    digest: string;
    size_bytes: number;
    media_type: string;
    policy_version: string;
  };
  reviews: OperatorReviewRecord[];
  can_review: boolean;
}
