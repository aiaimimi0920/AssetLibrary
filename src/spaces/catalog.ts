import { HttpError } from "../http";
import {
  isLoomPolicy,
  loomArtFormatPolicy,
  loomArtPolicy,
  loomCapabilityFormatPolicy,
  loomCapabilityPolicy,
  loomMcpFormatPolicy,
} from "../inspections/policy";

export const resourceSpaces = ["general", "loom", "otter", "framelab"] as const;
export type ResourceSpace = (typeof resourceSpaces)[number];

export const loomPoliciesSql = [
  loomArtPolicy,
  loomCapabilityPolicy,
  loomArtFormatPolicy,
  loomCapabilityFormatPolicy,
  loomMcpFormatPolicy,
]
  .map((value) => `'${value}'`)
  .join(", ");

const verifiedDatabases = new WeakSet<D1Database>();

/** 仅在确认存在两张展示表后缓存 true，兼容尚未执行 0013 的历史增量迁移验证。 */
export async function hasShowcaseSchema(db: D1Database): Promise<boolean> {
  if (verifiedDatabases.has(db)) return true;
  const row = await db
    .prepare(
      "SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name IN ('resource_profiles', 'version_profiles')",
    )
    .first<{ n: number }>();
  if (row?.n === 2) {
    verifiedDatabases.add(db);
    return true;
  }
  return false;
}

export function parseSpace(value: unknown): ResourceSpace {
  if (typeof value !== "string" || !resourceSpaces.includes(value as ResourceSpace))
    throw new HttpError(400, "INVALID_SPACE");
  return value as ResourceSpace;
}

export function parseSummary(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_SUMMARY");
  const trimmed = value.trim();
  if (trimmed.length > 160 || /\p{Cc}/u.test(trimmed)) throw new HttpError(400, "INVALID_SUMMARY");
  return trimmed;
}

export function parseDetail(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "INVALID_DETAIL");
  const normalized = value.replaceAll("\r\n", "\n").trim();
  if (normalized.length > 2000 || /[^\P{Cc}\n]/u.test(normalized))
    throw new HttpError(400, "INVALID_DETAIL");
  return normalized;
}

/** 仅接受源码内固定 SQL 列名，兼容无显式展示记录的历史版本。 */
export function defaultPolicySpaceSql(policyColumn: string) {
  return `(CASE WHEN ${policyColumn} IN (${loomPoliciesSql}) THEN 'loom' ELSE 'general' END)`;
}

export function effectiveVersionSpaceSql(
  hasShowcase = true,
  vpAlias = "vp",
  versionsAlias = "versions",
) {
  const fallback = defaultPolicySpaceSql(`${versionsAlias}.inspection_policy`);
  return hasShowcase ? `COALESCE(${vpAlias}.space, ${fallback})` : fallback;
}

export function effectiveVersionSpace(
  profileSpace: string | null | undefined,
  inspectionPolicy: string,
): ResourceSpace {
  if (profileSpace && resourceSpaces.includes(profileSpace as ResourceSpace))
    return profileSpace as ResourceSpace;
  return isLoomPolicy(inspectionPolicy) ? "loom" : "general";
}

export async function coverStreamResponse(
  bucket: R2Bucket,
  key: string,
  sha256: string,
  size: number,
  headOnly: boolean,
): Promise<Response> {
  const headers = {
    "Content-Type": "image/png",
    "Content-Length": String(size),
    ETag: `"${sha256}"`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'none'",
  };
  if (headOnly) {
    const head = await bucket.head(key);
    if (!head || head.size !== size) throw new HttpError(404, "NOT_FOUND");
    return new Response(null, { status: 200, headers });
  }
  const object = await bucket.get(key);
  if (!object || object.size !== size) throw new HttpError(404, "NOT_FOUND");
  return new Response(object.body, { status: 200, headers });
}
