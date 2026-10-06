import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
  assessSourceAudit,
  cargoInventory,
  sourceProvenance,
  verifySourceBlob,
} from "../scripts/scanner-source-policy.mjs";
import { registryDocument, upstreamFile } from "../scripts/scanner-source-tools.mjs";

const now = Date.UTC(2026, 9, 5, 4);
const revision = "a".repeat(40);
const lock = `version = 4
[[package]]
name = "test_registry"
version = "1.0.0"
source = "registry+https://github.com/rust-lang/crates.io-index"
[[package]]
name = "test_git"
version = "0.3.1"
source = "git+https://github.com/Cisco-Talos/onenote.rs.git#${"b".repeat(40)}"
`;
function provenance() {
  return {
    SLSA: {
      buildType: "https://mobyproject.org/buildkit@v1",
      materials: [
        { uri: "pkg:docker/clamav/clamav@1.5.4_base", digest: { sha256: "c".repeat(64) } },
      ],
      metadata: {
        completeness: { materials: false },
        "https://mobyproject.org/buildkit@v1#metadata": {
          vcs: { source: "https://github.com/Cisco-Talos/clamav.git", revision },
        },
      },
    },
  };
}
function input() {
  return {
    lock,
    compiler: provenance(),
    sbom: { SPDX: { spdxVersion: "SPDX-2.3", packages: [{ name: "musl" }] } },
    report: {
      SchemaVersion: 2,
      Trivy: { Version: "0.75.0" },
      ArtifactType: "filesystem",
      CreatedAt: new Date(now).toISOString(),
      Results: [
        {
          Target: "Cargo.lock",
          Type: "cargo",
          Class: "lang-pkgs",
          Packages: cargoInventory(lock).map((pkg) => ({ Name: pkg.name, Version: pkg.version })),
        },
      ],
    },
    database: { Version: 2, UpdatedAt: new Date(now).toISOString() },
  };
}

test("Cargo 保留 registry 与固定 Git 身份，不按同名版本替换来源", () => {
  const packages = cargoInventory(lock);
  assert.equal(packages.length, 2);
  assert.match(packages[1].source, /^git\+.*#b{40}$/);
  assert.throws(() => cargoInventory(lock.replace(/#b{40}/, "")), /CARGO_GIT_NOT_PINNED/);
  assert.throws(
    () => cargoInventory(`${lock}[[package]]${lock.split("[[package]]")[1]}`),
    /CARGO_PACKAGE_AMBIGUOUS/,
  );
  assert.throws(() => cargoInventory("version = 4\n"), /CARGO_INVENTORY_INVALID/);
});

test("源码必须同时匹配 GitHub 内容和 Git blob，不只信 revision 文案", () => {
  const bytes = Buffer.from(lock);
  const contents = {
    path: "Cargo.lock",
    encoding: "base64",
    content: bytes.toString("base64"),
    sha: createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex"),
  };
  assert.equal(verifySourceBlob(bytes, contents, revision).revision, revision);
  assert.throws(
    () => verifySourceBlob(Buffer.from(`${lock}\n`), contents, revision),
    /SOURCE_CONTENT_MISMATCH/,
  );
  assert.throws(
    () => verifySourceBlob(bytes, { ...contents, sha: "d".repeat(40) }, revision),
    /SOURCE_GIT_BLOB_MISMATCH/,
  );
});

test("镜像 wrapper 与 compiler 来源不符或缺 material 时失败关闭", () => {
  assert.equal(sourceProvenance(provenance(), provenance()).revision, revision);
  for (const mutate of [
    (v) => {
      v.SLSA.metadata["https://mobyproject.org/buildkit@v1#metadata"].vcs.revision = "b".repeat(40);
    },
    (v) => {
      v.SLSA.metadata["https://mobyproject.org/buildkit@v1#metadata"].vcs.source =
        "https://example.invalid";
    },
    (v) => {
      v.SLSA.buildType = "unknown";
    },
  ]) {
    const compiler = provenance();
    mutate(compiler);
    assert.throws(() => sourceProvenance(provenance(), compiler));
  }
  const wrapper = provenance();
  wrapper.SLSA.materials = [];
  assert.throws(() => sourceProvenance(wrapper, provenance()), /COMPILER_IMAGE_AMBIGUOUS/);
});

test("全部源码包必须逐项匹配报告，漏包、错误类型、隐藏和过期结果拒绝", () => {
  assert.equal(assessSourceAudit(input(), now).sourcePackages, 2);
  for (const mutate of [
    (v) => {
      v.report.Results[0].Packages.pop();
    },
    (v) => {
      v.report.Results[0].Packages.push(v.report.Results[0].Packages[0]);
    },
    (v) => {
      v.report.Results[0].Type = "alpine";
    },
    (v) => {
      v.report.Results[0].SuppressedFindings = [{}];
    },
    (v) => {
      v.report.CreatedAt = new Date(now - 21600000).toISOString();
    },
    (v) => {
      v.database.UpdatedAt = new Date(now - 86400000).toISOString();
    },
    (v) => {
      v.report.ArtifactType = "container_image";
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessSourceAudit(value, now));
  }
});

test("Git 分支依赖的公告不丢弃，但不能据同名版本宣称运行可利用", () => {
  for (const severity of ["LOW", "MEDIUM", "HIGH", "CRITICAL", "UNKNOWN"]) {
    const value = input();
    value.report.Results[0].Vulnerabilities = [
      {
        VulnerabilityID: "CVE-test",
        PkgName: "test_git",
        InstalledVersion: "0.3.1",
        Severity: severity,
      },
    ];
    const result = assessSourceAudit(value, now);
    assert.equal(result.counts[severity], 1);
    assert.match(result.findings[0].source, /^git\+/);
    assert.equal(result.findings[0].runtimeAffected, "not-established");
    assert.equal(
      result.blockers.includes("UNRESOLVED_SOURCE_VULNERABILITIES"),
      ["HIGH", "CRITICAL", "UNKNOWN"].includes(severity),
    );
  }
});

test("SBOM 缺原生组件和构建材料必须显示，源码零告警也不授予云准入", () => {
  const value = input();
  const missing = assessSourceAudit(value, now);
  assert(missing.blockers.includes("NATIVE_COMPONENTS_MISSING_FROM_UPSTREAM_SBOM"));
  assert(missing.blockers.includes("UPSTREAM_BUILD_MATERIALS_INCOMPLETE"));
  value.sbom.SPDX.packages.push({ name: "clamav" });
  value.compiler.SLSA.metadata.completeness.materials = true;
  const result = assessSourceAudit(value, now);
  assert.deepEqual(result.blockers, ["SOURCE_SCAN_NOT_RUNTIME_DEPENDENCY_PROOF"]);
  assert.equal(result.supplyChainValidated, false);
  assert.equal(result.cloudValidationEligible, false);
  assert.equal(result.publicationEligible, false);
});

test("下载和 registry 探测在执行前拒绝非预期位置或非 digest 镜像", async () => {
  await assert.rejects(
    upstreamFile("http://raw.githubusercontent.com/example", "unused"),
    /UPSTREAM_URL_INVALID/,
  );
  await assert.rejects(
    upstreamFile("https://example.invalid/file", "unused"),
    /UPSTREAM_URL_INVALID/,
  );
  await assert.rejects(
    registryDocument("clamav/clamav:latest", "Provenance", "unused"),
    /REGISTRY_REFERENCE_INVALID/,
  );
});

test("上游 HTTP 错误和超限响应主动取消响应体，不写出部分证据", async () => {
  const original = globalThis.fetch;
  try {
    for (const status of [404, 200]) {
      let cancelled = false;
      globalThis.fetch = async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(2097153));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status },
        );
      await assert.rejects(
        upstreamFile("https://raw.githubusercontent.com/test", "unused"),
        status === 404 ? /UPSTREAM_HTTP_ERROR/ : /UPSTREAM_BODY_TOO_LARGE/,
      );
      assert.equal(cancelled, true);
    }
  } finally {
    globalThis.fetch = original;
  }
});
