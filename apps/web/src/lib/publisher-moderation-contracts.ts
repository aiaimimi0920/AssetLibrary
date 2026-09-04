import type { PackageKind } from "./contracts";
import type {
  AppealResolution,
  ModerationActionKind,
  ModerationCaseStatus,
  ModerationTargetKind,
} from "./operator-moderation-contracts";

export interface PublisherModerationPackage {
  id: string;
  publisher_id: string;
  slug: string;
  name: string;
  kind: PackageKind;
}

export interface PublisherModerationRelease {
  id: string;
  version: string;
}

export interface PublisherModerationAction {
  id: string;
  action: ModerationActionKind;
  target_type: ModerationTargetKind;
  target_ref: string;
  status: "applied";
  reason_preview: string;
  applied_at: string;
}

export interface PublisherModerationCaseItem {
  id: string;
  status: Exclude<ModerationCaseStatus, "open">;
  package: PublisherModerationPackage;
  release: PublisherModerationRelease | null;
  action: PublisherModerationAction;
  created_at: string;
  updated_at: string;
}

export interface PublisherModerationCasePage {
  schema_version: "1.0";
  items: PublisherModerationCaseItem[];
  next_cursor: string | null;
}

export interface PublisherModerationAppeal {
  reason: string;
  resolution: AppealResolution | null;
  resolution_reason: string | null;
  resolved_at: string | null;
}

export interface PublisherModerationCaseDetail {
  schema_version: "1.0";
  item: PublisherModerationCaseItem;
  action_reason: string;
  appeal: PublisherModerationAppeal | null;
  can_appeal: boolean;
}

export interface PublisherModerationCaseView {
  id: string;
  package_id: string;
  release_id: string | null;
  status: ModerationCaseStatus;
}
