import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { trivyVersion } from "./scanner-release-policy.mjs";

/** 仅解析上游锁文件的包身份，不解析或执行 Cargo 配置、依赖脚本。 */
export function cargoInventory(text) {
  assert(text.length <= 1048576 && /^version = [34]$/m.test(text), "CARGO_LOCK_INVALID");
  const packages = text
    .split(/^\[\[package\]\]\s*$/m)
    .slice(1)
    .map((entry) => {
      const field = (name) => entry.match(new RegExp(`^${name} = "([^"\\r\\n]+)"$`, "m"))?.[1];
      const name = field("name");
      const version = field("version");
      const source = field("source") ?? "workspace";
      assert(name && version, "CARGO_PACKAGE_INVALID");
      assert(/^(registry\+|git\+|workspace$)/.test(source), "CARGO_SOURCE_UNKNOWN");
      if (source.startsWith("git+")) assert(/#[0-9a-f]{40}$/.test(source), "CARGO_GIT_NOT_PINNED");
      return { name, version, source };
    });
  assert(packages.length > 0 && packages.length <= 2000, "CARGO_INVENTORY_INVALID");
  const keys = packages.map((pkg) => `${pkg.name}@${pkg.version}`);
  assert.equal(new Set(keys).size, keys.length, "CARGO_PACKAGE_AMBIGUOUS");
  return packages;
}

export function verifySourceBlob(bytes, contents, revision) {
  assert(/^[0-9a-f]{40}$/.test(revision), "SOURCE_REVISION_INVALID");
  assert.equal(contents.path, "Cargo.lock", "SOURCE_PATH_INVALID");
  assert.equal(contents.encoding, "base64", "SOURCE_ENCODING_INVALID");
  assert.deepEqual(Buffer.from(contents.content, "base64"), bytes, "SOURCE_CONTENT_MISMATCH");
  const blob = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  assert.equal(blob, contents.sha, "SOURCE_GIT_BLOB_MISMATCH");
  return { revision, gitBlob: blob, sha256: createHash("sha256").update(bytes).digest("hex") };
}

export function sourceProvenance(wrapper, compiler) {
  const vcs = (value) =>
    value.SLSA?.metadata?.["https://mobyproject.org/buildkit@v1#metadata"]?.vcs;
  for (const value of [wrapper, compiler]) {
    assert.equal(
      value.SLSA?.buildType,
      "https://mobyproject.org/buildkit@v1",
      "BUILD_TYPE_UNKNOWN",
    );
    assert.equal(
      vcs(value)?.source,
      "https://github.com/Cisco-Talos/clamav.git",
      "SOURCE_REPOSITORY_MISMATCH",
    );
    assert(/^[0-9a-f]{40}$/.test(vcs(value)?.revision), "SOURCE_REVISION_MISSING");
  }
  assert.equal(vcs(wrapper).revision, vcs(compiler).revision, "BUILD_REVISIONS_DIFFER");
  const materials = wrapper.SLSA.materials.filter((item) =>
    item.uri?.startsWith("pkg:docker/clamav/clamav@"),
  );
  assert.equal(materials.length, 1, "COMPILER_IMAGE_AMBIGUOUS");
  assert(/^[0-9a-f]{64}$/.test(materials[0].digest?.sha256), "COMPILER_IMAGE_DIGEST_MISSING");
  return {
    revision: vcs(compiler).revision,
    compilerDigest: `sha256:${materials[0].digest.sha256}`,
  };
}

function fresh(value, limit, now, code) {
  const time = Date.parse(value);
  assert(Number.isFinite(time) && time <= now + 300000 && time > now - limit, code);
}

/** 全量 Cargo 报告验证可复用于源码和受控编译核验，不授予运行准入。 */
export function assessCargoScan({ lock, report, database }, now = Date.now()) {
  const packages = cargoInventory(lock);
  assert.equal(report.SchemaVersion, 2, "TRIVY_SCHEMA_INVALID");
  assert.equal(report.Trivy?.Version, trivyVersion, "TRIVY_VERSION_MISMATCH");
  assert.equal(report.ArtifactType, "filesystem", "SOURCE_REPORT_TYPE_INVALID");
  fresh(report.CreatedAt, 21600000, now, "SOURCE_REPORT_EXPIRED");
  assert.equal(database.Version, 2, "TRIVY_DATABASE_INVALID");
  fresh(database.UpdatedAt, 86400000, now, "TRIVY_DATABASE_EXPIRED");
  assert.equal(report.Results?.length, 1, "SOURCE_SCAN_SCOPE_INVALID");
  const result = report.Results[0];
  assert.equal(result.Type, "cargo", "CARGO_SCAN_MISSING");
  assert.equal(result.Class, "lang-pkgs", "CARGO_CLASS_INVALID");
  assert.equal(result.Target, "Cargo.lock", "CARGO_SCAN_TARGET_INVALID");
  assert(Array.isArray(result.Packages), "CARGO_SCAN_INVENTORY_MISSING");
  const identity = (items) => items.map((pkg) => `${pkg.name}@${pkg.version}`).sort();
  assert.deepEqual(
    identity(result.Packages.map((pkg) => ({ name: pkg.Name, version: pkg.Version }))),
    identity(packages),
    "CARGO_SCAN_INVENTORY_MISMATCH",
  );
  assert(!result.SuppressedFindings?.length, "SUPPRESSED_FINDINGS_NOT_ALLOWED");
  assert(
    result.Vulnerabilities === undefined || Array.isArray(result.Vulnerabilities),
    "FINDINGS_INVALID",
  );
  const counts = { UNKNOWN: 0, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0 };
  const findings = (result.Vulnerabilities ?? []).map((item) => {
    assert(Object.hasOwn(counts, item.Severity), "FINDING_SEVERITY_INVALID");
    const pkg = packages.find(
      (pkg) => pkg.name === item.PkgName && pkg.version === item.InstalledVersion,
    );
    assert(pkg && typeof item.VulnerabilityID === "string", "FINDING_PACKAGE_UNKNOWN");
    counts[item.Severity]++;
    return {
      id: item.VulnerabilityID,
      package: pkg.name,
      version: pkg.version,
      source: pkg.source,
      severity: item.Severity,
      fixedVersion: item.FixedVersion ?? null,
      runtimeAffected: "not-established",
    };
  });
  return { packages, counts, findings };
}

/** 源码锁文件是补充风险证据，不伪装成完整运行二进制 SBOM 或漏洞可达性证明。 */
export function assessSourceAudit({ lock, report, database, sbom, compiler }, now = Date.now()) {
  const { packages, counts, findings } = assessCargoScan({ lock, report, database }, now);
  assert.equal(sbom.SPDX?.spdxVersion, "SPDX-2.3", "UPSTREAM_SBOM_INVALID");
  assert(Array.isArray(sbom.SPDX.packages) && sbom.SPDX.packages.length > 0, "UPSTREAM_SBOM_EMPTY");
  const nativeNames = sbom.SPDX.packages
    .filter((pkg) => /clamav|clammspack/i.test(pkg.name))
    .map((pkg) => pkg.name);
  const blockers = ["SOURCE_SCAN_NOT_RUNTIME_DEPENDENCY_PROOF"];
  if (!nativeNames.length) blockers.push("NATIVE_COMPONENTS_MISSING_FROM_UPSTREAM_SBOM");
  if (compiler.SLSA?.metadata?.completeness?.materials !== true)
    blockers.push("UPSTREAM_BUILD_MATERIALS_INCOMPLETE");
  if (counts.HIGH + counts.CRITICAL + counts.UNKNOWN)
    blockers.push("UNRESOLVED_SOURCE_VULNERABILITIES");
  return {
    sourcePackages: packages.length,
    registryPackages: packages.filter((pkg) => pkg.source.startsWith("registry+")).length,
    gitPackages: packages.filter((pkg) => pkg.source.startsWith("git+")),
    findings,
    counts,
    upstreamSbomPackages: sbom.SPDX.packages.length,
    nativeNames,
    blockers,
    sourceInventoryMatched: true,
    runtimeDependencyCoverageProven: false,
    supplyChainValidated: false,
    cloudValidationEligible: false,
    publicationEligible: false,
    productionReady: false,
  };
}
