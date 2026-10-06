import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { verifyImageCoverage } from "./scanner-image-environment.mjs";
import { verifyRuntimeCases } from "./scanner-runtime-policy.mjs";

export const trivyVersion = "0.75.0";
export const trivyWindowsSha256 =
  "3b4fcf6fec53c4c73c325cfd518c7264100695b19e6c59c6a777e4a67dc9f0e6";
export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const digest = /^[0-9a-f]{64}$/;
const imageId = /^sha256:[0-9a-f]{64}$/;

function recent(value, maxAge, now) {
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isSafeInteger(time) && time <= now + 300000 && time > now - maxAge;
}

/** 全量报告保留未修复项；缺报告、未知严重性和旧漏洞库不能隐式放行。 */
export function vulnerabilitySummary(report, expectedImage, database, now = Date.now()) {
  assert(imageId.test(expectedImage), "INVALID_IMAGE_ID");
  assert.equal(report.SchemaVersion, 2, "INVALID_TRIVY_SCHEMA");
  assert.equal(report.Trivy?.Version, trivyVersion, "TRIVY_VERSION_MISMATCH");
  assert.equal(report.ArtifactType, "container_image", "INVALID_TRIVY_ARTIFACT");
  assert.equal(report.Metadata?.ImageID, expectedImage, "SCANNED_IMAGE_MISMATCH");
  assert(
    Array.isArray(report.Results) && report.Results.some((r) => r.Class === "os-pkgs"),
    "MISSING_OS_SCAN",
  );
  assert(recent(report.CreatedAt, 21600000, now), "VULNERABILITY_REPORT_EXPIRED");
  assert.equal(database?.Version, 2, "INVALID_TRIVY_DATABASE");
  assert(recent(database.UpdatedAt, 86400000, now), "VULNERABILITY_DATABASE_EXPIRED");
  const counts = { UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  const findings = [];
  for (const result of report.Results) {
    assert(!result.MisconfSummary?.Failures, "UNEXPECTED_MISCONFIGURATION");
    assert(!result.SuppressedFindings?.length, "SUPPRESSED_FINDINGS_NOT_ALLOWED");
    assert(
      result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities),
      "INVALID_VULNERABILITIES",
    );
    for (const item of result.Vulnerabilities ?? []) {
      assert(Object.hasOwn(counts, item.Severity), "INVALID_VULNERABILITY_SEVERITY");
      assert(
        typeof item.VulnerabilityID === "string" && typeof item.PkgName === "string",
        "INVALID_FINDING",
      );
      counts[item.Severity]++;
      findings.push({
        id: item.VulnerabilityID,
        package: item.PkgName,
        severity: item.Severity,
        installedVersion: item.InstalledVersion,
        fixedVersion: item.FixedVersion ?? null,
      });
    }
  }
  return { counts, findings, blocked: counts.HIGH + counts.CRITICAL + counts.UNKNOWN > 0 };
}

function checkedDatabase(database, now) {
  assert(Array.isArray(database?.files) && database.files.length === 3, "DATABASE_FILES_MISSING");
  for (const [index, prefix] of ["main", "daily", "bytecode"].entries()) {
    const file = database.files[index];
    assert([`${prefix}.cvd`, `${prefix}.cld`].includes(file.name), "DATABASE_FILE_ORDER");
    assert(digest.test(file.sha256), "DATABASE_DIGEST_INVALID");
    assert(Number.isSafeInteger(file.version) && file.version > 0, "DATABASE_VERSION_INVALID");
    assert(
      Number.isSafeInteger(file.updatedAt) && file.updatedAt > 0 && file.updatedAt <= now + 300000,
      "DATABASE_TIME_INVALID",
    );
  }
  assert.equal(
    database.sha256,
    sha256(JSON.stringify(database.files)),
    "DATABASE_IDENTITY_INVALID",
  );
  assert.equal(database.updatedAt, database.files[1].updatedAt, "DAILY_TIME_MISMATCH");
  assert.equal(database.dailyVersion, database.files[1].version, "DAILY_VERSION_MISMATCH");
  return database;
}

/** 这里只判定候选是否可进入后续验收，绝不把 OS 扫描或历史批准变成生产发布许可。 */
export function assessScannerRelease(
  { runtime, report, vulnerabilityDatabase, previous },
  now = Date.now(),
) {
  assert(imageId.test(runtime?.image?.id), "RUNTIME_IMAGE_MISSING");
  assert(/^[0-9a-f-]{36}$/.test(runtime.image.signatureRefresh), "SIGNATURE_REFRESH_NOT_PROVEN");
  assert(recent(runtime.image.created, 21600000, now), "CANDIDATE_BUILD_EXPIRED");
  assert.deepEqual(runtime.actual?.temporary, [], "RUNTIME_CLEANUP_NOT_PROVEN");
  const db = checkedDatabase(runtime.actual?.database, now);
  const runtimeCoverage = verifyRuntimeCases(runtime, db, now);
  const vulnerabilities = vulnerabilitySummary(
    report,
    runtime.image.id,
    vulnerabilityDatabase,
    now,
  );
  const coverage = verifyImageCoverage(report, runtime.actual.environment);
  const blockers = [];
  if (!recent(db.updatedAt, 129600000, now)) blockers.push("SIGNATURE_RELEASE_WINDOW_EXPIRED");
  if (vulnerabilities.blocked) blockers.push("UNRESOLVED_IMAGE_VULNERABILITIES");
  if (previous) {
    const old = checkedDatabase(previous, now);
    for (let index = 0; index < 3; index++) {
      if (
        db.files[index].version < old.files[index].version ||
        db.files[index].updatedAt < old.files[index].updatedAt
      )
        blockers.push(`SIGNATURE_ROLLBACK_FORBIDDEN:${index}`);
    }
  }
  return {
    candidateEligible: blockers.length === 0,
    blockers,
    imageId: runtime.image.id,
    database: db,
    releaseUntil: Math.min(
      db.updatedAt + 129600000,
      Date.parse(report.CreatedAt) + 21600000,
      Date.parse(runtime.image.created) + 21600000,
      Date.parse(vulnerabilityDatabase.UpdatedAt) + 86400000,
    ),
    vulnerabilities,
    coverage,
    runtimeCoverage,
    cloudValidated: false,
    publicationEligible: false,
    productionReady: false,
  };
}
