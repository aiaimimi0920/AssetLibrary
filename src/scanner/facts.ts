export { scanPolicy } from "../inspections/policy";
export const cloudScanBlocker = "SCANNER_CLOUD_NOT_VALIDATED";
export interface ScanFact {
  protocol: "neuro-clamav-v1";
  verdict: "clean" | "infected";
  sha256: string;
  size: number;
  engineVersion: "1.5.4";
  database: { sha256: string; dailyVersion: number; updatedAt: number };
  completedAt: number;
  expiresAt: number;
}
function exact(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("SCANNER_RESPONSE_INVALID");
  return value as Record<string, unknown>;
}

/** 不可变事实的结构/身份/相对期限校验与当前时效分离，过期不改写历史结果。 */
export function parseScanFact(value: unknown, sha256: string, size: number): ScanFact {
  const body = exact(value, [
    "protocol",
    "verdict",
    "sha256",
    "size",
    "engineVersion",
    "database",
    "completedAt",
    "expiresAt",
  ]);
  const database = exact(body.database, ["sha256", "dailyVersion", "updatedAt"]);
  if (
    body.protocol !== "neuro-clamav-v1" ||
    (body.verdict !== "clean" && body.verdict !== "infected") ||
    body.sha256 !== sha256 ||
    body.size !== size ||
    body.engineVersion !== "1.5.4" ||
    typeof database.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(database.sha256) ||
    !Number.isSafeInteger(database.dailyVersion) ||
    (database.dailyVersion as number) < 1 ||
    !Number.isSafeInteger(database.updatedAt) ||
    (database.updatedAt as number) <= 0 ||
    !Number.isSafeInteger(body.completedAt) ||
    (body.completedAt as number) <= 0 ||
    (database.updatedAt as number) > (body.completedAt as number) + 300000 ||
    !Number.isSafeInteger(body.expiresAt) ||
    (body.expiresAt as number) <= (body.completedAt as number) ||
    (body.expiresAt as number) > (body.completedAt as number) + 86400000 ||
    (body.expiresAt as number) > (database.updatedAt as number) + 172800000
  )
    throw new Error("SCANNER_FACT_INVALID");
  return body as unknown as ScanFact;
}
export function scanCurrent(scan: ScanFact, now = Date.now()) {
  return (
    scan.expiresAt > now &&
    scan.completedAt <= now + 5000 &&
    scan.database.updatedAt <= now + 300000 &&
    scan.database.updatedAt > now - 172800000
  );
}
