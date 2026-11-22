import { HttpError } from "../http";

export const requestCategories = [
  "models",
  "images",
  "materials",
  "audio",
  "effects",
  "templates",
] as const;
export type RequestCategory = (typeof requestCategories)[number];

export const assetCategories = ["general", ...requestCategories] as const;
export type AssetCategory = (typeof assetCategories)[number];

export const assetStyles = [
  "general",
  "pixel",
  "lowpoly",
  "realistic",
  "stylized",
  "handdrawn",
] as const;
export type AssetStyle = (typeof assetStyles)[number];

export const assetFormats = [
  "PNG",
  "SVG",
  "ASEPRITE",
  "GLB",
  "FBX",
  "BLEND",
  "SHADER",
  "WAV",
  "OGG",
  "LUT",
  "GDSCRIPT",
  "ZIP",
] as const;
export type AssetFormat = (typeof assetFormats)[number];

export const requestLicenses = ["commercial", "personal", "open_source"] as const;
export type RequestLicense = (typeof requestLicenses)[number];

export const assetLicenses = ["unspecified", ...requestLicenses] as const;
export type AssetLicense = (typeof assetLicenses)[number];

export interface AssetAttributes {
  category: AssetCategory;
  style: AssetStyle;
  formats: AssetFormat[];
  license: AssetLicense;
}

export const defaultAssetAttributes: AssetAttributes = {
  category: "general",
  style: "general",
  formats: [],
  license: "unspecified",
};

const verifiedAssetSchema = new WeakSet<D1Database>();

/** 仅在确认 0014 的五张增量表全部存在后缓存 true，兼容历史增量迁移验证。 */
export async function hasAssetMarketSchema(db: D1Database): Promise<boolean> {
  if (verifiedAssetSchema.has(db)) return true;
  const row = await db
    .prepare(
      `SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN (
        'resource_asset_attributes', 'version_asset_attributes',
        'asset_requests', 'asset_request_responses', 'asset_request_events'
      )`,
    )
    .first<{ n: number }>();
  if (row?.n === 5) {
    verifiedAssetSchema.add(db);
    return true;
  }
  return false;
}

export function parseAssetCategory(value: unknown): AssetCategory {
  if (typeof value !== "string" || !assetCategories.includes(value as AssetCategory))
    throw new HttpError(400, "INVALID_ASSET_CATEGORY");
  return value as AssetCategory;
}

export function parseRequestCategory(value: unknown): RequestCategory {
  if (typeof value !== "string" || !requestCategories.includes(value as RequestCategory))
    throw new HttpError(400, "INVALID_ASSET_CATEGORY");
  return value as RequestCategory;
}

export function parseAssetStyle(value: unknown): AssetStyle {
  if (typeof value !== "string" || !assetStyles.includes(value as AssetStyle))
    throw new HttpError(400, "INVALID_ASSET_STYLE");
  return value as AssetStyle;
}

export function parseAssetFormats(value: unknown, requireNonEmpty = false): AssetFormat[] {
  if (!Array.isArray(value) || value.length > 4 || (requireNonEmpty && value.length === 0))
    throw new HttpError(400, "INVALID_ASSET_FORMATS");
  const seen = new Set<AssetFormat>();
  for (const entry of value) {
    if (typeof entry !== "string") throw new HttpError(400, "INVALID_ASSET_FORMATS");
    const upper = entry.trim().toUpperCase() as AssetFormat;
    if (!assetFormats.includes(upper) || seen.has(upper))
      throw new HttpError(400, "INVALID_ASSET_FORMATS");
    seen.add(upper);
  }
  return [...seen].sort();
}

export function parseAssetLicense(value: unknown): AssetLicense {
  if (typeof value !== "string" || !assetLicenses.includes(value as AssetLicense))
    throw new HttpError(400, "INVALID_ASSET_LICENSE");
  return value as AssetLicense;
}

export function parseRequestLicense(value: unknown): RequestLicense {
  if (typeof value !== "string" || !requestLicenses.includes(value as RequestLicense))
    throw new HttpError(400, "INVALID_ASSET_LICENSE");
  return value as RequestLicense;
}

export function parseRequestTitle(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_REQUEST_TITLE");
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 120 || /\p{Cc}/u.test(trimmed))
    throw new HttpError(400, "INVALID_REQUEST_TITLE");
  return trimmed;
}

export function parsePeriodDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > 180)
    throw new HttpError(400, "INVALID_PERIOD_DAYS");
  return value;
}

export function parseBudgetNote(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_BUDGET_NOTE");
  const trimmed = value.trim();
  if (trimmed.length > 80 || /\p{Cc}/u.test(trimmed))
    throw new HttpError(400, "INVALID_BUDGET_NOTE");
  return trimmed;
}

export function parseBoundedMultiline(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== "string") throw new HttpError(400, code);
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (normalized.length < 1 || normalized.length > maxLength || /[^\P{Cc}\n]/u.test(normalized))
    throw new HttpError(400, code);
  return normalized;
}

export function decodeFormats(raw: string | null | undefined): AssetFormat[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is AssetFormat => assetFormats.includes(item))
      : [];
  } catch {
    return [];
  }
}
