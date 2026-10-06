import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessScannerRelease,
  sha256,
  vulnerabilitySummary,
} from "../scripts/scanner-release-policy.mjs";
import { imageInventory } from "./scanner-image-fixture.mjs";
import { runtimeFixture } from "./scanner-runtime-fixture.mjs";

const now = Date.UTC(2026, 9, 5, 3);
const image = `sha256:${"a".repeat(64)}`;
function database(time = now - 3600000) {
  const files = ["main", "daily", "bytecode"].map((name, index) => ({
    name: `${name}.cvd`,
    sha256: String(index + 1).repeat(64),
    version: 100 + index,
    updatedAt: time,
  }));
  return { files, sha256: sha256(JSON.stringify(files)), dailyVersion: 101, updatedAt: time };
}
function input() {
  const db = database();
  return {
    runtime: runtimeFixture(db, now, image),
    report: {
      SchemaVersion: 2,
      Trivy: { Version: "0.75.0" },
      ArtifactType: "container_image",
      Metadata: { ImageID: image, OS: { Family: "alpine", Name: "3.24.2" } },
      CreatedAt: new Date(now).toISOString(),
      Results: [imageInventory()],
    },
    vulnerabilityDatabase: { Version: 2, UpdatedAt: new Date(now - 3600000).toISOString() },
  };
}

test("新鲜完整候选只允许进入后续验收，不授予生产发布资格", () => {
  const result = assessScannerRelease(input(), now);
  assert.equal(result.candidateEligible, true);
  assert.equal(result.productionReady, false);
  assert.equal(result.publicationEligible, false);
  assert.equal(result.releaseUntil, now + 21600000);
});

test("未修复 HIGH/CRITICAL 和 UNKNOWN 均阻断，低等级完整保留", () => {
  for (const severity of ["HIGH", "CRITICAL", "UNKNOWN", "MEDIUM", "LOW"]) {
    const value = input();
    value.report.Results[0].Vulnerabilities.push({
      VulnerabilityID: "CVE-test",
      PkgName: "package",
      Severity: severity,
    });
    const result = assessScannerRelease(value, now);
    assert.equal(result.vulnerabilities.counts[severity], 1);
    assert.equal(result.vulnerabilities.findings[0].fixedVersion, null);
    assert.equal(result.candidateEligible, !["HIGH", "CRITICAL", "UNKNOWN"].includes(severity));
  }
});

test("缺报告、错误镜像或版本、隐藏结果、非法严重性拒绝而非零漏洞", () => {
  for (const mutate of [
    (v) => {
      v.report.Results = [];
    },
    (v) => {
      v.report.Metadata.ImageID = `sha256:${"b".repeat(64)}`;
    },
    (v) => {
      v.report.Trivy.Version = "0.1.0";
    },
    (v) => {
      v.report.Results[0].SuppressedFindings = [{}];
    },
    (v) => {
      v.report.Results[0].Vulnerabilities = {};
    },
    (v) => {
      v.report.Results[0].Vulnerabilities = [
        { VulnerabilityID: "x", PkgName: "p", Severity: "none" },
      ];
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessScannerRelease(value, now));
  }
});

test("六小时报告、24小时漏洞库和构建过期拒绝，不能复用旧绿色", () => {
  for (const mutate of [
    (v) => {
      v.report.CreatedAt = new Date(now - 21600000).toISOString();
    },
    (v) => {
      v.vulnerabilityDatabase.UpdatedAt = new Date(now - 86400000).toISOString();
    },
    (v) => {
      v.runtime.image.created = new Date(now - 21600000).toISOString();
    },
    (v) => {
      v.report.CreatedAt = new Date(now + 300001).toISOString();
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessScannerRelease(value, now));
  }
});

test("签名必须保留12小时寿命，runtime仍有效不等于可以新发布", () => {
  const value = input();
  value.runtime = runtimeFixture(database(now - 129600000), now, image);
  const result = assessScannerRelease(value, now);
  assert.deepEqual(result.blockers, ["SIGNATURE_RELEASE_WINDOW_EXPIRED"]);
});

test("代码回滚不能使任意一个签名库版本或时间倒退", () => {
  for (let index = 0; index < 3; index++) {
    for (const field of ["version", "updatedAt"]) {
      const value = input();
      value.previous = structuredClone(value.runtime.actual.database);
      value.previous.files[index][field]++;
      value.previous.sha256 = sha256(JSON.stringify(value.previous.files));
      value.previous.dailyVersion = value.previous.files[1].version;
      value.previous.updatedAt = value.previous.files[1].updatedAt;
      const result = assessScannerRelease(value, now);
      assert.equal(result.candidateEligible, false);
      assert(result.blockers.includes(`SIGNATURE_ROLLBACK_FORBIDDEN:${index}`));
    }
  }
  const value = input();
  value.previous = structuredClone(value.runtime.actual.database);
  assert.equal(assessScannerRelease(value, now).candidateEligible, true);
});

test("刷新缺失、签名身份篡改、实际加载不符及残留临时目录失败关闭", () => {
  for (const mutate of [
    (v) => {
      v.runtime.image.signatureRefresh = "unmanaged";
    },
    (v) => {
      v.runtime.actual.database.files[0].version++;
    },
    (v) => {
      v.runtime.actual.database.files.reverse();
    },
    (v) => {
      v.runtime.cases[0].body.database = database(now - 1000);
    },
    (v) => {
      v.runtime.actual.temporary = ["assetlibrary-scan-leftover"];
    },
    (v) => {
      v.runtime.cases.pop();
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessScannerRelease(value, now));
  }
});

test("同一漏洞影响多个包保留每条，不把package occurrence声称unique CVE", () => {
  const value = input();
  value.report.Results[0].Vulnerabilities = ["one", "two"].map((PkgName) => ({
    VulnerabilityID: "CVE-shared",
    PkgName,
    Severity: "HIGH",
    FixedVersion: "2.0",
  }));
  const result = vulnerabilitySummary(value.report, image, value.vulnerabilityDatabase, now);
  assert.equal(result.counts.HIGH, 2);
  assert.equal(result.findings.length, 2);
});
