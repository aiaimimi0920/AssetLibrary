import type {
  OwnedPackage,
  OwnedPackagePage,
  OwnedPackageSummary,
  OwnedRelease,
  OwnedReleasePage,
  PrincipalRef,
  PublisherMembership,
  PublisherMembershipPage,
  PublicCompatibility,
} from "./publisher-contracts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const tagPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function isLine(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === "string"
    && (empty || value.length > 0)
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function isMultiline(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function isDateTime(value: unknown): value is string {
  return isLine(value, 64) && rfc3339Pattern.test(value) && Number.isFinite(Date.parse(value));
}

function isCursor(value: unknown): value is string | null {
  return value === null || typeof value === "string" && value.length <= 256;
}

function uniqueStrings(value: unknown, maximum: number, predicate: (item: string) => boolean): value is string[] {
  return Array.isArray(value)
    && value.length <= maximum
    && value.every((item) => typeof item === "string" && predicate(item))
    && new Set(value).size === value.length;
}

function parsePrincipal(value: unknown): PrincipalRef {
  if (!isExactRecord(value, ["issuer", "subject"])
    || !isLine(value.issuer, 200)
    || !isLine(value.subject, 200)) {
    throw new Error("Invalid Publisher principal contract");
  }
  return value as unknown as PrincipalRef;
}

function parseMembership(value: unknown): PublisherMembership {
  if (!isExactRecord(value, ["publisher", "publisher_status", "role"])
    || !isExactRecord(value.publisher, ["id", "slug", "display_name"])
    || typeof value.publisher.id !== "string" || !uuidPattern.test(value.publisher.id)
    || typeof value.publisher.slug !== "string" || !slugPattern.test(value.publisher.slug)
    || !isLine(value.publisher.display_name, 160)
    || !["pending", "active", "suspended", "closed"].includes(String(value.publisher_status))
    || !["owner", "maintainer", "release_manager"].includes(String(value.role))) {
    throw new Error("Invalid Publisher membership contract");
  }
  return value as unknown as PublisherMembership;
}

function parsePackageSummary(value: unknown, full: false): OwnedPackageSummary;
function parsePackageSummary(value: unknown, full: true): OwnedPackage;
function parsePackageSummary(value: unknown, full: boolean): OwnedPackageSummary | OwnedPackage {
  const keys = ["id", "publisher_id", "slug", "kind", "status", "visibility", "name", "summary",
    ...(full ? ["description"] : []), "tags", "created_at", "updated_at"];
  if (!isExactRecord(value, keys)
    || typeof value.id !== "string" || !uuidPattern.test(value.id)
    || typeof value.publisher_id !== "string" || !uuidPattern.test(value.publisher_id)
    || typeof value.slug !== "string" || !slugPattern.test(value.slug)
    || !["art", "capability", "app_update"].includes(String(value.kind))
    || !["draft", "submitted", "published", "suspended", "deprecated", "archived"].includes(String(value.status))
    || !["public", "unlisted", "private"].includes(String(value.visibility))
    || !isLine(value.name, 160)
    || !isLine(value.summary, 1000, true)
    || full && !isMultiline(value.description, 100_000)
    || !uniqueStrings(value.tags, 32, (tag) => tagPattern.test(tag))
    || !isDateTime(value.created_at)
    || !isDateTime(value.updated_at)) {
    throw new Error("Invalid owned package contract");
  }
  return value as unknown as OwnedPackageSummary | OwnedPackage;
}

function parseCompatibility(value: unknown): PublicCompatibility {
  if (!isExactRecord(value, ["products"])
    || !Array.isArray(value.products)
    || value.products.length > 8) {
    throw new Error("Invalid release compatibility contract");
  }
  const names = new Set<string>();
  for (const product of value.products) {
    if (!isExactRecord(product, ["name", "version_requirement"])
      || !["loom", "hook"].includes(String(product.name))
      || names.has(String(product.name))
      || !isLine(product.version_requirement, 100)) {
      throw new Error("Invalid release compatibility contract");
    }
    names.add(String(product.name));
  }
  return value as unknown as PublicCompatibility;
}

export function parseOwnedPackage(value: unknown): OwnedPackage {
  return parsePackageSummary(value, true);
}

export function parseMembershipPage(value: unknown): PublisherMembershipPage {
  if (!isExactRecord(value, ["schema_version", "items", "next_cursor"])
    || value.schema_version !== "1.0"
    || !Array.isArray(value.items) || value.items.length > 100
    || !isCursor(value.next_cursor)) {
    throw new Error("Invalid Publisher membership-page contract");
  }
  const items = value.items.map(parseMembership);
  return { schema_version: "1.0", items, next_cursor: value.next_cursor };
}

export function parseOwnedPackagePage(value: unknown): OwnedPackagePage {
  if (!isExactRecord(value, ["schema_version", "items", "next_cursor"])
    || value.schema_version !== "1.0"
    || !Array.isArray(value.items) || value.items.length > 100
    || !isCursor(value.next_cursor)) {
    throw new Error("Invalid owned package-page contract");
  }
  const items = value.items.map((item) => parsePackageSummary(item, false));
  return { schema_version: "1.0", items, next_cursor: value.next_cursor };
}

export function parseOwnedRelease(value: unknown): OwnedRelease {
  const keys = ["id", "package_id", "version", "status", "compatibility", "permissions", "created_by",
    "published_at", "yanked_at", "created_at", "updated_at"];
  if (!isExactRecord(value, keys)
    || typeof value.id !== "string" || !uuidPattern.test(value.id)
    || typeof value.package_id !== "string" || !uuidPattern.test(value.package_id)
    || typeof value.version !== "string" || value.version.length > 100 || !semverPattern.test(value.version)
    || !["draft", "uploading", "submitted", "in_review", "approved", "published", "rejected", "yanked"].includes(String(value.status))
    || !uniqueStrings(value.permissions, 64, (permission) => isLine(permission, 160))
    || !(value.published_at === null || isDateTime(value.published_at))
    || !(value.yanked_at === null || isDateTime(value.yanked_at))
    || !isDateTime(value.created_at) || !isDateTime(value.updated_at)) {
    throw new Error("Invalid owned release contract");
  }
  const compatibility = parseCompatibility(value.compatibility);
  const createdBy = parsePrincipal(value.created_by);
  return {
    ...(value as unknown as OwnedRelease),
    compatibility,
    created_by: createdBy,
  };
}

export function parseOwnedReleasePage(value: unknown): OwnedReleasePage {
  if (!isExactRecord(value, ["schema_version", "items", "next_cursor"])
    || value.schema_version !== "1.0"
    || !Array.isArray(value.items) || value.items.length > 100
    || !isCursor(value.next_cursor)) {
    throw new Error("Invalid owned release-page contract");
  }
  const items = value.items.map(parseOwnedRelease);
  return { schema_version: "1.0", items, next_cursor: value.next_cursor };
}
