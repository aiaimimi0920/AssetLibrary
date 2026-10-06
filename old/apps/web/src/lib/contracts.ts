export const CONTRACT_SCHEMA_VERSION = "1.0" as const;

export type PackageKind = "art" | "capability" | "app_update";
export type PackageStatus = "published" | "suspended" | "archived";

export interface PublisherSummary {
  id: string;
  slug: string;
  display_name: string;
}

export interface PublishedPackage {
  id: string;
  slug: string;
  name: string;
  kind: PackageKind;
  publisher: PublisherSummary;
  status: PackageStatus;
  summary: string;
}

export interface PackagePage {
  schema_version: typeof CONTRACT_SCHEMA_VERSION;
  items: PublishedPackage[];
  next_cursor: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parsePublishedPackage(value: unknown): PublishedPackage {
  if (!isRecord(value) || !isRecord(value.publisher)) {
    throw new Error("Invalid AssetLibrary package contract");
  }
  const isValid = (
    typeof value.id === "string" &&
    typeof value.slug === "string" &&
    typeof value.name === "string" &&
    ["art", "capability", "app_update"].includes(String(value.kind)) &&
    ["published", "suspended", "archived"].includes(String(value.status)) &&
    typeof value.summary === "string" &&
    typeof value.publisher.id === "string" &&
    typeof value.publisher.slug === "string" &&
    typeof value.publisher.display_name === "string"
  );
  if (!isValid) throw new Error("Invalid AssetLibrary package contract");
  return value as unknown as PublishedPackage;
}

export function parsePackagePage(value: unknown): PackagePage {
  if (
    !isRecord(value) ||
    value.schema_version !== CONTRACT_SCHEMA_VERSION ||
    !Array.isArray(value.items) ||
    !value.items.every((item) => {
      try {
        parsePublishedPackage(item);
        return true;
      } catch {
        return false;
      }
    }) ||
    !(typeof value.next_cursor === "string" || value.next_cursor === null)
  ) {
    throw new Error("Invalid AssetLibrary package-page contract");
  }
  return value as unknown as PackagePage;
}
