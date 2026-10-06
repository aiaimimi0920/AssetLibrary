import { CONTRACT_SCHEMA_VERSION, type PublisherSummary } from "./contracts";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RFC3339_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/;

export type HostProduct = "loom" | "hook";

export interface PublisherProfile {
  schema_version: typeof CONTRACT_SCHEMA_VERSION;
  publisher: PublisherSummary;
}

export interface ProductCompatibility {
  name: HostProduct;
  version_requirement: string;
}

export interface PublishedReleaseArtifact {
  artifact_id: string;
  release_id: string;
  digest: string;
  size_bytes: number;
  media_type: string;
  file_name: string;
  signing_key_id: string;
}

export interface PublishedRelease {
  id: string;
  version: string;
  published_at: string;
  compatibility: { products: ProductCompatibility[] };
  permissions: string[];
  artifacts: PublishedReleaseArtifact[];
}

export interface PublishedReleasePage {
  schema_version: typeof CONTRACT_SCHEMA_VERSION;
  items: PublishedRelease[];
  next_cursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedText(value: unknown, maximum: number): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximum
    && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

function isRfc3339(value: string): boolean {
  const match = RFC3339_PATTERN.exec(value);
  if (!match) return false;
  const [year, month, day, hour, minute, second, offsetHour, offsetMinute] = match
    .slice(1)
    .map((part) => Number(part ?? 0));
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12
    && day >= 1 && day <= (days[month - 1] ?? 0)
    && hour <= 23 && minute <= 59 && second <= 59
    && offsetHour <= 23 && offsetMinute <= 59
    && !Number.isNaN(Date.parse(value));
}

function isPublisher(value: unknown): value is PublisherSummary {
  return isRecord(value)
    && exactKeys(value, ["id", "slug", "display_name"])
    && typeof value.id === "string"
    && UUID_PATTERN.test(value.id)
    && typeof value.slug === "string"
    && /^[a-z0-9][a-z0-9-]{0,119}$/.test(value.slug)
    && boundedText(value.display_name, 160);
}

export function parsePublisherProfile(value: unknown): PublisherProfile {
  if (
    !isRecord(value)
    || !exactKeys(value, ["schema_version", "publisher"])
    || value.schema_version !== CONTRACT_SCHEMA_VERSION
    || !isPublisher(value.publisher)
  ) {
    throw new Error("Invalid AssetLibrary publisher contract");
  }
  return value as unknown as PublisherProfile;
}

function isCompatibility(value: unknown): value is PublishedRelease["compatibility"] {
  if (!isRecord(value) || !exactKeys(value, ["products"]) || !Array.isArray(value.products) || value.products.length > 8) {
    return false;
  }
  const names = new Set<string>();
  return value.products.every((product) => {
    if (
      !isRecord(product)
      || !exactKeys(product, ["name", "version_requirement"])
      || !["loom", "hook"].includes(String(product.name))
      || !boundedText(product.version_requirement, 100)
      || names.has(String(product.name))
    ) return false;
    names.add(String(product.name));
    return true;
  });
}

function isArtifact(value: unknown, releaseId: string): value is PublishedReleaseArtifact {
  return isRecord(value)
    && exactKeys(value, ["artifact_id", "release_id", "digest", "size_bytes", "media_type", "file_name", "signing_key_id"])
    && typeof value.artifact_id === "string"
    && UUID_PATTERN.test(value.artifact_id)
    && value.release_id === releaseId
    && typeof value.digest === "string"
    && /^[a-f0-9]{64}$/.test(value.digest)
    && typeof value.size_bytes === "number"
    && Number.isSafeInteger(value.size_bytes)
    && value.size_bytes > 0
    && boundedText(value.media_type, 200)
    && typeof value.file_name === "string"
    && /^[A-Za-z0-9._-]{1,180}$/.test(value.file_name)
    && value.file_name !== "."
    && value.file_name !== ".."
    && boundedText(value.signing_key_id, 160);
}

function isRelease(value: unknown): value is PublishedRelease {
  if (
    !isRecord(value)
    || !exactKeys(value, ["id", "version", "published_at", "compatibility", "permissions", "artifacts"])
    || typeof value.id !== "string"
    || !UUID_PATTERN.test(value.id)
    || !boundedText(value.version, 100)
    || !boundedText(value.published_at, 64)
    || !isRfc3339(value.published_at)
    || !isCompatibility(value.compatibility)
    || !Array.isArray(value.permissions)
    || value.permissions.length > 64
    || !value.permissions.every((permission) => boundedText(permission, 160))
    || new Set(value.permissions).size !== value.permissions.length
    || !Array.isArray(value.artifacts)
    || value.artifacts.length < 1
    || value.artifacts.length > 32
  ) return false;
  return value.artifacts.every((artifact) => isArtifact(artifact, value.id as string));
}

export function parsePublishedReleasePage(value: unknown): PublishedReleasePage {
  if (
    !isRecord(value)
    || !exactKeys(value, ["schema_version", "items", "next_cursor"])
    || value.schema_version !== CONTRACT_SCHEMA_VERSION
    || !Array.isArray(value.items)
    || value.items.length > 100
    || !value.items.every(isRelease)
    || !(value.next_cursor === null || boundedText(value.next_cursor, 256))
  ) {
    throw new Error("Invalid AssetLibrary release-page contract");
  }
  const ids = new Set<string>();
  const ordered = value.items.every((release, index, items) => {
    if (ids.has(release.id)) return false;
    ids.add(release.id);
    if (index === 0) return true;
    const previous = items[index - 1];
    const previousTime = Date.parse(previous.published_at);
    const currentTime = Date.parse(release.published_at);
    return previousTime > currentTime
      || previousTime === currentTime && previous.id.localeCompare(release.id) < 0;
  });
  if (!ordered) throw new Error("Invalid AssetLibrary release-page order");
  return value as unknown as PublishedReleasePage;
}
