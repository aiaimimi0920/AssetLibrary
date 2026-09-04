import type {
  PublisherModerationAction,
  PublisherModerationAppeal,
  PublisherModerationCaseDetail,
  PublisherModerationCaseItem,
  PublisherModerationCasePage,
  PublisherModerationCaseView,
  PublisherModerationPackage,
  PublisherModerationRelease,
} from "./publisher-moderation-contracts";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slug = /^[a-z0-9][a-z0-9-]{0,119}$/;
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const rfc3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return record(value) && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function line(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function multiline(value: unknown, maximum: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function dateTime(value: unknown): value is string {
  return line(value, 64) && rfc3339.test(value) && Number.isFinite(Date.parse(value));
}

function parsePackage(value: unknown): PublisherModerationPackage {
  if (!exact(value, ["id", "publisher_id", "slug", "name", "kind"])
    || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.publisher_id !== "string" || !uuid.test(value.publisher_id)
    || typeof value.slug !== "string" || !slug.test(value.slug)
    || !line(value.name, 160)
    || !["art", "capability", "app_update"].includes(String(value.kind))) {
    throw new Error("Invalid publisher moderation package contract");
  }
  return value as unknown as PublisherModerationPackage;
}

function parseRelease(value: unknown): PublisherModerationRelease | null {
  if (value === null) return null;
  if (!exact(value, ["id", "version"])
    || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.version !== "string" || value.version.length > 100 || !semver.test(value.version)) {
    throw new Error("Invalid publisher moderation release contract");
  }
  return value as unknown as PublisherModerationRelease;
}

function validPair(action: unknown, target: unknown): boolean {
  return action === "block" && ["publisher", "package", "release", "artifact", "signing_key"].includes(String(target))
    || action === "suspend" && ["publisher", "package"].includes(String(target))
    || action === "yank" && target === "release"
    || action === "revoke" && ["artifact", "signing_key"].includes(String(target));
}

function parseAction(value: unknown): PublisherModerationAction {
  const keys = ["id", "action", "target_type", "target_ref", "status", "reason_preview", "applied_at"];
  if (!exact(value, keys) || typeof value.id !== "string" || !uuid.test(value.id)
    || !validPair(value.action, value.target_type) || !line(value.target_ref, 200)
    || value.status !== "applied" || !multiline(value.reason_preview, 240)
    || !dateTime(value.applied_at)) {
    throw new Error("Invalid publisher moderation action contract");
  }
  return value as unknown as PublisherModerationAction;
}

function parseItem(value: unknown): PublisherModerationCaseItem {
  const keys = ["id", "status", "package", "release", "action", "created_at", "updated_at"];
  if (!exact(value, keys) || typeof value.id !== "string" || !uuid.test(value.id)
    || !["actioned", "appealed", "resolved"].includes(String(value.status))
    || !dateTime(value.created_at) || !dateTime(value.updated_at)) {
    throw new Error("Invalid publisher moderation case contract");
  }
  return {
    ...(value as unknown as PublisherModerationCaseItem),
    package: parsePackage(value.package),
    release: parseRelease(value.release),
    action: parseAction(value.action),
  };
}

function parseAppeal(value: unknown): PublisherModerationAppeal | null {
  if (value === null) return null;
  if (!exact(value, ["reason", "resolution", "resolution_reason", "resolved_at"])
    || !multiline(value.reason, 4_000)
    || !(value.resolution === null || ["upheld", "block_lifted"].includes(String(value.resolution)))
    || !(value.resolution_reason === null || multiline(value.resolution_reason, 4_000))
    || !(value.resolved_at === null || dateTime(value.resolved_at))
    || (value.resolution !== null) !== (value.resolution_reason !== null)
    || (value.resolution !== null) !== (value.resolved_at !== null)) {
    throw new Error("Invalid publisher moderation appeal contract");
  }
  return value as unknown as PublisherModerationAppeal;
}

export function parsePublisherModerationCasePage(value: unknown): PublisherModerationCasePage {
  if (!exact(value, ["schema_version", "items", "next_cursor"])
    || value.schema_version !== "1.0" || !Array.isArray(value.items) || value.items.length > 100
    || !(value.next_cursor === null || line(value.next_cursor, 256))) {
    throw new Error("Invalid publisher moderation page contract");
  }
  return { schema_version: "1.0", items: value.items.map(parseItem), next_cursor: value.next_cursor };
}

export function parsePublisherModerationCaseDetail(value: unknown): PublisherModerationCaseDetail {
  if (!exact(value, ["schema_version", "item", "action_reason", "appeal", "can_appeal"])
    || value.schema_version !== "1.0" || !multiline(value.action_reason, 4_000)
    || typeof value.can_appeal !== "boolean") {
    throw new Error("Invalid publisher moderation detail contract");
  }
  const item = parseItem(value.item);
  const appeal = parseAppeal(value.appeal);
  const stateMatches = item.status === "actioned" ? appeal === null && value.can_appeal
    : item.status === "appealed" ? appeal !== null && appeal.resolution === null && !value.can_appeal
      : appeal !== null && appeal.resolution !== null && !value.can_appeal;
  if (!stateMatches) throw new Error("Inconsistent publisher moderation state");
  return { schema_version: "1.0", item, action_reason: value.action_reason, appeal, can_appeal: value.can_appeal };
}

export function parsePublisherModerationCaseView(value: unknown): PublisherModerationCaseView {
  if (!exact(value, ["id", "package_id", "release_id", "status"])
    || typeof value.id !== "string" || !uuid.test(value.id)
    || typeof value.package_id !== "string" || !uuid.test(value.package_id)
    || !(value.release_id === null || typeof value.release_id === "string" && uuid.test(value.release_id))
    || !["open", "actioned", "appealed", "resolved"].includes(String(value.status))) {
    throw new Error("Invalid publisher moderation mutation contract");
  }
  return value as unknown as PublisherModerationCaseView;
}
