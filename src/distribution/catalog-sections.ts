import {
  type AssetFormat,
  type AssetStyle,
  assetFormats,
  assetStyles,
  type RequestCategory,
  type RequestLicense,
  requestCategories,
  requestLicenses,
} from "../assets/taxonomy";
import { HttpError } from "../http";
import { effectiveVersionSpaceSql, type ResourceSpace, resourceSpaces } from "../spaces/catalog";

// 仅使用固定包合同与已审核版本空间分类，不凭名称猜测宿主兼容性。
export function catalogSection(url: URL, hasShowcase = true) {
  const value = url.searchParams.get("section");
  if (value === null) return "";
  const effectiveSpace = effectiveVersionSpaceSql(hasShowcase, "vp", "versions");
  const sections: Record<string, string> = {
    applications: "versions.kind = 'application'",
    loom: `${effectiveSpace} = 'loom' AND versions.kind IN ('art', 'capability', 'mcp')`,
    assets: `versions.kind = 'art' AND ${effectiveSpace} <> 'loom'`,
  };
  if (url.searchParams.getAll("section").length !== 1 || !Object.hasOwn(sections, value))
    throw new HttpError(400, "INVALID_CATALOG_FILTER");
  return `AND (${sections[value]})`;
}

export function catalogSpace(url: URL): ResourceSpace | null {
  const value = url.searchParams.get("space");
  if (value === null) return null;
  if (
    url.searchParams.getAll("space").length !== 1 ||
    !resourceSpaces.includes(value as ResourceSpace)
  )
    throw new HttpError(400, "INVALID_CATALOG_FILTER");
  return value as ResourceSpace;
}

export interface CatalogAssetFilters {
  category: RequestCategory | null;
  style: AssetStyle | null;
  format: AssetFormat | null;
  license: RequestLicense | null;
}

function singleChoice<T extends string>(url: URL, name: string, allowed: readonly T[]): T | null {
  const value = url.searchParams.get(name);
  if (value === null) return null;
  if (url.searchParams.getAll(name).length !== 1 || !allowed.includes(value as T))
    throw new HttpError(400, "INVALID_CATALOG_FILTER");
  return value as T;
}

export function catalogAssetFilters(url: URL): CatalogAssetFilters {
  return {
    category: singleChoice(url, "category", requestCategories),
    style: singleChoice(url, "style", assetStyles),
    format: singleChoice(url, "format", assetFormats),
    license: singleChoice(url, "license", requestLicenses),
  };
}
