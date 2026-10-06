import assert from "node:assert/strict";
import { test } from "node:test";
import { assessNativeRisk } from "../scripts/scanner-native-risk-policy.mjs";

const image = `sha256:${"a".repeat(64)}`;
const git = `git+https://github.com/example/fork?branch=stable#${"b".repeat(40)}`;
const registry = "registry+https://github.com/rust-lang/crates.io-index";
function fixture() {
  const now = new Date().toISOString();
  const database = { Version: 2, UpdatedAt: now };
  return {
    image,
    imageDatabase: database,
    sourceDatabase: database,
    runtime: { packages: ["nodejs-24.18.1-r0"] },
    imageReport: {
      SchemaVersion: 2,
      Trivy: { Version: "0.75.0" },
      ArtifactType: "container_image",
      CreatedAt: now,
      Metadata: { ImageID: image, OS: { Name: "3.24.2" } },
      Results: [
        { Class: "os-pkgs", Type: "alpine", Packages: [{ Name: "nodejs", Version: "24.18.1-r0" }] },
      ],
    },
    lock: `version = 3\n[[package]]\nname = "parser"\nversion = "1.0.0"\nsource = "${git}"\n[[package]]\nname = "unused"\nversion = "2.0.0"\nsource = "${registry}"\n`,
    metadata: {
      packages: [
        { id: "parser-id", name: "parser", version: "1.0.0", source: git },
        { id: "unused-id", name: "unused", version: "2.0.0", source: registry },
      ],
    },
    rust: [
      {
        packageId: "parser-id",
        target: { name: "parser" },
        features: [],
        files: { "/build/parser.rlib": "c".repeat(64) },
      },
    ],
    sourceReport: {
      SchemaVersion: 2,
      Trivy: { Version: "0.75.0" },
      ArtifactType: "filesystem",
      CreatedAt: now,
      Results: [
        {
          Target: "Cargo.lock",
          Class: "lang-pkgs",
          Type: "cargo",
          Packages: [
            { Name: "parser", Version: "1.0.0" },
            { Name: "unused", Version: "2.0.0" },
          ],
          Vulnerabilities: [
            {
              VulnerabilityID: "test-medium",
              PkgName: "parser",
              InstalledVersion: "1.0.0",
              Severity: "MEDIUM",
            },
            {
              VulnerabilityID: "test-low",
              PkgName: "unused",
              InstalledVersion: "2.0.0",
              Severity: "LOW",
            },
          ],
        },
      ],
    },
  };
}

test("实际编译关联保留完整 Git 来源和产物，不宣称运行可利用或安全", () => {
  const result = assessNativeRisk(fixture());
  assert.equal(result.findings[0].compiled, true);
  assert.equal(result.findings[0].source, git);
  assert.equal(result.findings[0].artifactTargets[0].files["/build/parser.rlib"], "c".repeat(64));
  assert.equal(result.findings[0].runtimeAffected, "not-established");
  for (const key of [
    "supplyChainValidated",
    "cloudValidationEligible",
    "publicationEligible",
    "productionReady",
  ])
    assert.equal(result[key], false);
});

test("没有编译的锁文件告警仍保留，不能自动豁免", () => {
  const finding = assessNativeRisk(fixture()).findings[1];
  assert.equal(finding.compiled, false);
  assert.equal(finding.disposition, "review-required");
});

test("APK 空清单、漏包、重复和版本漂移全部拒绝", () => {
  for (const packages of [
    [],
    [{ Name: "nodejs", Version: "wrong" }],
    [
      { Name: "nodejs", Version: "24.18.1-r0" },
      { Name: "nodejs", Version: "24.18.1-r0" },
    ],
  ]) {
    const input = fixture();
    input.imageReport.Results[0].Packages = packages;
    assert.throws(() => assessNativeRisk(input), /NATIVE_RISK_OS_/);
  }
});

test("同名同版本但 Git commit 不同不得关联", () => {
  const input = fixture();
  input.metadata.packages[0].source = git.replace("b".repeat(40), "d".repeat(40));
  assert.throws(() => assessNativeRisk(input), /CARGO_RESOLUTION_MISMATCH/);
});

test("未知编译包、空产物和缺少实际编译记录拒绝", () => {
  for (const mutate of [
    (input) => {
      input.rust[0].packageId = "unknown";
    },
    (input) => {
      input.rust[0].files = {};
    },
    (input) => {
      input.rust = [];
    },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => assessNativeRisk(input), /NATIVE_RISK_/);
  }
});

test("报告必须属于同一镜像，源码清单缺项不能通过", () => {
  const input = fixture();
  input.imageReport.Metadata.ImageID = `sha256:${"d".repeat(64)}`;
  assert.throws(() => assessNativeRisk(input), /SCANNED_IMAGE_MISMATCH/);
  const source = fixture();
  source.sourceReport.Results[0].Packages.pop();
  assert.throws(() => assessNativeRisk(source), /CARGO_SCAN_INVENTORY_MISMATCH/);
});

test("镜像 HIGH 告警保留并阻断，不因编译身份通过被覆盖", () => {
  const input = fixture();
  input.imageReport.Results[0].Vulnerabilities = [
    { VulnerabilityID: "test-high", PkgName: "nodejs", Severity: "HIGH" },
  ];
  const result = assessNativeRisk(input);
  assert.equal(result.imageRisk.counts.HIGH, 1);
  assert(result.blockers.includes("IMAGE_HIGH_CRITICAL_UNKNOWN_FINDINGS"));
});

test("零源码告警也不授予原生 C/C++、签名、云或生产安全资格", () => {
  const input = fixture();
  input.sourceReport.Results[0].Vulnerabilities = [];
  const result = assessNativeRisk(input);
  assert(result.blockers.includes("NATIVE_C_CPP_COMPONENT_VULNERABILITY_COVERAGE_PENDING"));
  assert.equal(result.productionReady, false);
});
