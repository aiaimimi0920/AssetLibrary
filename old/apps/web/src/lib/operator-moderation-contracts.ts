import type { OperatorReviewPackage } from "./operator-contracts";

export type ModerationCaseStatus = "open" | "actioned" | "appealed" | "resolved";
export type ModerationActionKind = "suspend" | "yank" | "revoke" | "block";
export type ModerationTargetKind = "publisher" | "package" | "release" | "artifact" | "signing_key";
export type ModerationActionStatus = "proposed" | "applied";
export type AppealResolution = "upheld" | "block_lifted";

export interface OperatorModerationRelease { id: string; version: string }

export interface OperatorModerationCaseItem {
  id: string;
  status: ModerationCaseStatus;
  package: OperatorReviewPackage;
  release: OperatorModerationRelease | null;
  reason_preview: string;
  action_status: ModerationActionStatus | null;
  created_at: string;
  updated_at: string;
}

export interface OperatorModerationQueuePage {
  schema_version: "1.0";
  items: OperatorModerationCaseItem[];
  next_cursor: string | null;
}

export interface OperatorModerationActionRecord {
  id: string;
  action: ModerationActionKind;
  target_type: ModerationTargetKind;
  target_ref: string;
  status: ModerationActionStatus;
  reason: string;
  created_at: string;
  applied_at: string | null;
  can_approve: boolean;
}

export interface OperatorModerationAppeal {
  reason: string;
  resolution: AppealResolution | null;
  resolution_reason: string | null;
  resolved_at: string | null;
}

export interface OperatorModerationCaseDetail {
  schema_version: "1.0";
  item: OperatorModerationCaseItem;
  report_reason: string;
  evidence_urls: string[];
  actions: OperatorModerationActionRecord[];
  appeal: OperatorModerationAppeal | null;
  can_propose: boolean;
  can_resolve: boolean;
}

export interface ProposeModerationActionRequest {
  action: ModerationActionKind;
  target_type: ModerationTargetKind;
  target_ref: string;
  reason: string;
}

export interface ResolveModerationRequest { resolution: AppealResolution; reason: string }

export interface ModerationCaseView {
  id: string;
  package_id: string;
  release_id: string | null;
  status: ModerationCaseStatus;
}

export interface ModerationActionView {
  id: string;
  case_id: string;
  action: ModerationActionKind;
  target_type: ModerationTargetKind;
  target_ref: string;
  status: ModerationActionStatus;
}
