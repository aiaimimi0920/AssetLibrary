import document from "./deployment-release.json";
import { type ScanFact, scanCurrent } from "./facts";

export interface ScannerRelease {
  id: string;
  accountId: string;
  worker: string;
  origin: string;
  service: string;
  workerVersionId: string;
  containerApplicationId: string;
  namespaceId: string;
  imageDigest: string;
  imageId: string;
  database: ScanFact["database"];
  validatedAt: number;
  expiresAt: number;
  evidence: { candidate: string; nativeReview: string; cloudValidation: string };
}
export interface DeploymentEnv {
  SCANNER?: Fetcher;
  SCANNER_RELEASE_ID?: string;
  APP_ORIGIN?: string;
}
const digest = /^[0-9a-f]{64}$/;
const image = /^sha256:[0-9a-f]{64}$/;
const name = /^[a-z0-9][a-z0-9-]{0,62}$/;
function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}
function matches(value: unknown, pattern: RegExp): value is string {
  return typeof value === "string" && pattern.test(value);
}
function timestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

/** 只读取随应用版本发布的验收记录；请求、数据库及任意环境布尔值均不能创建准入。 */
export function parseDeploymentRelease(value: unknown, now = Date.now()): ScannerRelease | null {
  if (!exact(value, ["schemaVersion", "release"]) || value.schemaVersion !== 1) return null;
  const release = value.release;
  if (
    !exact(release, [
      "id",
      "accountId",
      "worker",
      "origin",
      "service",
      "workerVersionId",
      "containerApplicationId",
      "namespaceId",
      "imageDigest",
      "imageId",
      "database",
      "validatedAt",
      "expiresAt",
      "evidence",
    ])
  )
    return null;
  if (
    !matches(release.id, digest) ||
    !matches(release.accountId, /^[0-9a-f]{32}$/) ||
    !matches(release.worker, name) ||
    !matches(release.service, name) ||
    release.worker === release.service ||
    !matches(release.workerVersionId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) ||
    !matches(release.containerApplicationId, /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) ||
    !matches(release.namespaceId, /^[0-9a-f]{32}$/) ||
    !matches(release.imageDigest, image) ||
    !matches(release.imageId, image) ||
    !exact(release.database, ["sha256", "dailyVersion", "updatedAt"]) ||
    !matches(release.database.sha256, digest) ||
    !timestamp(release.database.dailyVersion) ||
    !timestamp(release.database.updatedAt) ||
    !exact(release.evidence, ["candidate", "nativeReview", "cloudValidation"]) ||
    !Object.values(release.evidence).every((entry) => matches(entry, digest)) ||
    !timestamp(release.validatedAt) ||
    !timestamp(release.expiresAt) ||
    release.validatedAt > now ||
    release.expiresAt <= now ||
    release.expiresAt <= release.validatedAt ||
    release.expiresAt > release.validatedAt + 86400000 ||
    release.database.updatedAt > release.validatedAt + 300000 ||
    release.expiresAt > release.database.updatedAt + 172800000
  )
    return null;
  try {
    const origin = new URL(String(release.origin));
    if (origin.protocol !== "https:" || origin.origin !== release.origin) return null;
  } catch {
    return null;
  }
  return release as unknown as ScannerRelease;
}

export function deploymentAdmission(env: DeploymentEnv, now = Date.now()) {
  const release = parseDeploymentRelease(document, now);
  return release &&
    env.SCANNER &&
    env.SCANNER_RELEASE_ID === release.id &&
    env.APP_ORIGIN === release.origin
    ? release
    : null;
}

/** 验收之前的历史 clean 不自动升级；只接受同一签名库且在本次验收后完成的扫描。 */
export function admittedScan(scan: ScanFact | null, release: ScannerRelease, now = Date.now()) {
  return (
    !!scan &&
    scan.verdict === "clean" &&
    scanCurrent(scan, now) &&
    release.validatedAt <= now &&
    release.expiresAt > now &&
    scan.completedAt >= release.validatedAt &&
    scan.completedAt < release.expiresAt &&
    scan.database.sha256 === release.database.sha256 &&
    scan.database.dailyVersion === release.database.dailyVersion &&
    scan.database.updatedAt === release.database.updatedAt
  );
}
