import assert from "node:assert/strict";
import { vulnerabilitySummary } from "./scanner-release-policy.mjs";
import { assessCargoScan } from "./scanner-source-policy.mjs";

/** 关联真实编译包而非仅匹配名称；编译存在不等于漏洞可达，未编译也不自动豁免。 */
export function assessNativeRisk(input, now = Date.now()) {
  const {
    image,
    imageReport,
    imageDatabase,
    runtime,
    metadata,
    rust,
    lock,
    sourceReport,
    sourceDatabase,
  } = input;
  const imageRisk = vulnerabilitySummary(imageReport, image, imageDatabase, now);
  const os = imageReport.Results.filter((result) => result.Class === "os-pkgs");
  assert.equal(os.length, 1, "NATIVE_RISK_OS_SCOPE_INVALID");
  assert.equal(os[0].Type, "alpine", "NATIVE_RISK_OS_INVALID");
  assert.equal(imageReport.Metadata.OS?.Name, "3.24.2", "NATIVE_RISK_OS_VERSION");
  assert.notEqual(imageReport.Metadata.OS.Eosl, true, "NATIVE_RISK_OS_UNSUPPORTED");
  assert(os[0].Packages?.length > 0, "NATIVE_RISK_OS_PACKAGES_MISSING");
  const actual = os[0].Packages.map((pkg) => `${pkg.Name}-${pkg.Version}`).sort();
  assert.deepEqual(actual, [...runtime.packages].sort(), "NATIVE_RISK_OS_INVENTORY_MISMATCH");
  const cargo = assessCargoScan({ lock, report: sourceReport, database: sourceDatabase }, now);
  const identity = (pkg) => `${pkg.name}@${pkg.version}|${pkg.source ?? "workspace"}`;
  assert.deepEqual(
    metadata.packages.map(identity).sort(),
    cargo.packages.map(identity).sort(),
    "NATIVE_RISK_CARGO_RESOLUTION_MISMATCH",
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  assert.equal(packages.size, metadata.packages.length, "NATIVE_RISK_DUPLICATE_PACKAGE");
  assert(rust.length > 0, "NATIVE_RISK_NO_ARTIFACTS");
  const compiled = new Map();
  for (const artifact of rust) {
    const pkg = packages.get(artifact.packageId);
    assert(pkg, "NATIVE_RISK_UNKNOWN_ARTIFACT");
    assert(Object.keys(artifact.files).length > 0, "NATIVE_RISK_EMPTY_ARTIFACT");
    compiled.set(identity(pkg), [...(compiled.get(identity(pkg)) ?? []), artifact]);
  }
  const findings = cargo.findings.map((finding) => {
    const artifacts = compiled.get(`${finding.package}@${finding.version}|${finding.source}`) ?? [];
    return {
      ...finding,
      compiled: artifacts.length > 0,
      artifactTargets: artifacts.map((entry) => ({
        packageId: entry.packageId,
        target: entry.target.name,
        features: entry.features,
        files: entry.files,
      })),
      runtimeAffected: "not-established",
      disposition: "review-required",
    };
  });
  return {
    imageRisk,
    osPackages: actual.length,
    runtimeApkInventoryMatched: true,
    resolvedCargoPackages: cargo.packages.length,
    compiledCargoPackages: compiled.size,
    sourceCounts: cargo.counts,
    findings,
    blockers: [
      ...(imageRisk.blocked ? ["IMAGE_HIGH_CRITICAL_UNKNOWN_FINDINGS"] : []),
      ...(findings.length ? ["COMPILED_SOURCE_FINDINGS_REVIEW_PENDING"] : []),
      "NATIVE_C_CPP_COMPONENT_VULNERABILITY_COVERAGE_PENDING",
      "SIGNATURE_FRESHNESS_AND_PRODUCT_REGRESSION_PENDING",
      "NEW_IMAGE_CLOUD_VALIDATION_PENDING",
    ],
    supplyChainValidated: false,
    cloudValidationEligible: false,
    publicationEligible: false,
    productionReady: false,
  };
}
