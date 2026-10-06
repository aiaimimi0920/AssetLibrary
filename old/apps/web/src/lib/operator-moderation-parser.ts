import type {
  AppealResolution,
  ModerationActionKind,
  ModerationActionView,
  ModerationCaseStatus,
  ModerationCaseView,
  ModerationTargetKind,
  OperatorModerationActionRecord,
  OperatorModerationAppeal,
  OperatorModerationCaseDetail,
  OperatorModerationCaseItem,
  OperatorModerationQueuePage,
} from "./operator-moderation-contracts";
import type { OperatorReviewPackage } from "./operator-contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9][a-z0-9-]{0,119}$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const caseStatuses: ModerationCaseStatus[] = ["open", "actioned", "appealed", "resolved"];
const actions: ModerationActionKind[] = ["suspend", "yank", "revoke", "block"];
const targets: ModerationTargetKind[] = ["publisher", "package", "release", "artifact", "signing_key"];

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function line(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === "string" && (empty || value.length > 0) && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function multiline(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function date(value: unknown): value is string {
  return line(value, 64) && Number.isFinite(Date.parse(value));
}

function parsePackage(value: unknown): OperatorReviewPackage {
  if (!exact(value, ["id", "slug", "name", "kind", "summary", "publisher"])
    || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.slug !== "string" || !slug.test(value.slug)
    || !line(value.name, 160) || !line(value.summary, 1_000, true)
    || !["art", "capability", "app_update"].includes(String(value.kind))
    || !exact(value.publisher, ["id", "slug", "display_name"])
    || typeof value.publisher.id !== "string" || !uuid.test(value.publisher.id)
    || typeof value.publisher.slug !== "string" || !slug.test(value.publisher.slug)
    || !line(value.publisher.display_name, 160)) throw new Error("Invalid moderation package");
  return value as unknown as OperatorReviewPackage;
}

function parseItem(value: unknown): OperatorModerationCaseItem {
  const keys = ["id", "status", "package", "release", "reason_preview", "action_status", "created_at", "updated_at"];
  if (!exact(value, keys) || typeof value.id !== "string" || !uuid.test(value.id)
    || !caseStatuses.includes(value.status as ModerationCaseStatus)
    || !multiline(value.reason_preview, 240) || !date(value.created_at) || !date(value.updated_at)
    || !(value.action_status === null || ["proposed", "applied"].includes(String(value.action_status)))) {
    throw new Error("Invalid moderation case item");
  }
  const release = value.release;
  if (!(release === null || exact(release, ["id", "version"])
    && typeof release.id === "string" && uuid.test(release.id)
    && typeof release.version === "string" && release.version.length <= 100 && semver.test(release.version))) {
    throw new Error("Invalid moderation release");
  }
  const status = value.status as ModerationCaseStatus;
  if (status === "open" ? value.action_status === "applied" : value.action_status !== "applied") {
    throw new Error("Moderation case and action states disagree");
  }
  return { ...value, package: parsePackage(value.package) } as OperatorModerationCaseItem;
}

function validPair(action: ModerationActionKind, target: ModerationTargetKind): boolean {
  return action === "block" || action === "suspend" && ["publisher", "package"].includes(target)
    || action === "yank" && target === "release"
    || action === "revoke" && ["artifact", "signing_key"].includes(target);
}

function parseAction(value: unknown): OperatorModerationActionRecord {
  const keys = ["id", "action", "target_type", "target_ref", "status", "reason", "created_at", "applied_at", "can_approve"];
  if (!exact(value, keys) || typeof value.id !== "string" || !uuid.test(value.id)
    || !actions.includes(value.action as ModerationActionKind)
    || !targets.includes(value.target_type as ModerationTargetKind)
    || !validPair(value.action as ModerationActionKind, value.target_type as ModerationTargetKind)
    || !line(value.target_ref, 200) || !multiline(value.reason, 4_000)
    || !["proposed", "applied"].includes(String(value.status)) || !date(value.created_at)
    || !(value.applied_at === null || date(value.applied_at)) || typeof value.can_approve !== "boolean"
    || (value.status === "proposed") !== (value.applied_at === null)
    || value.status === "applied" && value.can_approve) throw new Error("Invalid moderation action");
  return value as unknown as OperatorModerationActionRecord;
}

function parseAppeal(value: unknown): OperatorModerationAppeal {
  const keys = ["reason", "resolution", "resolution_reason", "resolved_at"];
  if (!exact(value, keys) || !multiline(value.reason, 4_000)
    || !(value.resolution === null || ["upheld", "block_lifted"].includes(String(value.resolution)))
    || !(value.resolution_reason === null || multiline(value.resolution_reason, 4_000))
    || !(value.resolved_at === null || date(value.resolved_at))
    || (value.resolution !== null) !== (value.resolution_reason !== null)
    || (value.resolution !== null) !== (value.resolved_at !== null)) throw new Error("Invalid moderation appeal");
  return value as unknown as OperatorModerationAppeal;
}

export function parseOperatorModerationQueuePage(value: unknown): OperatorModerationQueuePage {
  if (!exact(value, ["schema_version", "items", "next_cursor"]) || value.schema_version !== "1.0"
    || !Array.isArray(value.items) || value.items.length > 100
    || !(value.next_cursor === null || line(value.next_cursor, 256))) throw new Error("Invalid moderation queue");
  const items = value.items.map(parseItem);
  if (items.some((item) => item.status === "resolved")) throw new Error("Resolved case appeared in active queue");
  return { schema_version: "1.0", items, next_cursor: value.next_cursor };
}

export function parseOperatorModerationCaseDetail(value: unknown): OperatorModerationCaseDetail {
  const keys = ["schema_version", "item", "report_reason", "evidence_urls", "actions", "appeal", "can_propose", "can_resolve"];
  if (!exact(value, keys) || value.schema_version !== "1.0" || !multiline(value.report_reason, 4_000)
    || !Array.isArray(value.evidence_urls) || value.evidence_urls.length > 20
    || !value.evidence_urls.every((url) => line(url, 2_000) && url.startsWith("https://"))
    || !Array.isArray(value.actions) || value.actions.length > 1
    || typeof value.can_propose !== "boolean" || typeof value.can_resolve !== "boolean") {
    throw new Error("Invalid moderation case detail");
  }
  const item = parseItem(value.item);
  const parsedActions = value.actions.map(parseAction);
  const appeal = value.appeal === null ? null : parseAppeal(value.appeal);
  const validState = item.status === "open"
    ? appeal === null && !value.can_resolve && (parsedActions.length === 0) === value.can_propose
    : item.status === "actioned"
      ? appeal === null && !value.can_propose && !value.can_resolve
      : item.status === "appealed"
        ? appeal?.resolution === null && !value.can_propose && value.can_resolve
        : appeal !== null && appeal.resolution !== null && !value.can_propose && !value.can_resolve;
  if (!validState) throw new Error("Moderation detail state is inconsistent");
  return { ...value, item, actions: parsedActions, appeal } as OperatorModerationCaseDetail;
}

export function parseModerationCaseView(value: unknown): ModerationCaseView {
  if (!exact(value, ["id", "package_id", "release_id", "status"])
    || ![value.id, value.package_id].every((id) => typeof id === "string" && uuid.test(id))
    || !(value.release_id === null || typeof value.release_id === "string" && uuid.test(value.release_id))
    || !caseStatuses.includes(value.status as ModerationCaseStatus)) throw new Error("Invalid moderation case response");
  return value as unknown as ModerationCaseView;
}

export function parseModerationActionView(value: unknown): ModerationActionView {
  if (!exact(value, ["id", "case_id", "action", "target_type", "target_ref", "status"])
    || ![value.id, value.case_id].every((id) => typeof id === "string" && uuid.test(id))
    || !actions.includes(value.action as ModerationActionKind)
    || !targets.includes(value.target_type as ModerationTargetKind)
    || !validPair(value.action as ModerationActionKind, value.target_type as ModerationTargetKind)
    || !line(value.target_ref, 200) || !["proposed", "applied"].includes(String(value.status))) {
    throw new Error("Invalid moderation action response");
  }
  return value as unknown as ModerationActionView;
}
