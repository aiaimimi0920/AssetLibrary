import assert from "node:assert/strict";
import { test } from "node:test";
import { assessNativeProof } from "../scripts/scanner-native-policy.mjs";
import { parseNativeTree } from "../scripts/scanner-native-tools.mjs";

const digest = "a".repeat(64);
function proof() {
  const binaries = {};
  const installed = {};
  for (const name of [
    "/usr/bin/clamscan",
    "/usr/lib/libclamav.so.12",
    "/usr/lib/libfreshclam.so.4",
    "/usr/lib/libclamunrar.so",
    "/usr/lib/libclamunrar_iface.so",
  ]) {
    binaries[name] = { path: name, sha256: digest };
    installed[name.slice(1)] = { sha256: digest };
  }
  return {
    tree: [{ mode: "100644", blob: "b".repeat(40), path: "libclamav_rust/Cargo.toml" }],
    source: {
      "libclamav_rust/Cargo.toml": {
        gitBlob: "b".repeat(40),
        rawGitBlob: "b".repeat(40),
        sha256: digest,
        exportTransform: "none",
      },
    },
    vendor: { "vendor/dep/Cargo.toml": { sha256: digest } },
    metadata: {
      packages: [
        { id: "clamav_rust", manifest_path: "/src/libclamav_rust/Cargo.toml", source: null },
        {
          id: "dep",
          manifest_path: "/src/.cargo/vendor/dep/Cargo.toml",
          source: `git+https://github.com/example/dep#${"c".repeat(40)}`,
        },
      ],
      resolve: { nodes: [{ id: "clamav_rust" }, { id: "dep" }] },
    },
    rust: [
      {
        packageId: "clamav_rust",
        target: { name: "clamav_rust", crate_types: ["staticlib"] },
        files: { "/build/libclamav_rust.a": digest },
      },
    ],
    installed,
    dependencies: {
      "/src/libclamav/scan.c": digest,
      "/src/libclammspack/mspack.c": digest,
      "/src/libclamunrar/unrar.cpp": digest,
    },
    runtime: {
      network: "none",
      oomKilled: false,
      packages: ["nodejs-24.18.1-r0"],
      libraries: { "/usr/lib/libclamav.so.12.1.0": digest },
      version: "ClamAV 1.5.4/28143/date",
      clean: { status: 0 },
      eicar: { status: 1, stdout: "stdin: Win.Test.EICAR_HDB-1 FOUND" },
      linkedLibraries: "libclamav.so.12 => /usr/lib/libclamav.so.12",
      binaries,
    },
    build: {
      version: "1.5.4",
      network: "none",
      cargoFrozen: true,
      productionReady: false,
      supplyChainValidated: false,
    },
    command: { args: ["build", "--frozen"], offline: "true" },
    cache:
      "ENABLE_UNRAR:BOOL=ON\nENABLE_LIBCLAMAV_ONLY:BOOL=OFF\nENABLE_EXTERNAL_MSPACK:BOOL=OFF\nBYTECODE_RUNTIME:STRING=interpreter\nENABLE_JSON_SHARED:BOOL=ON\n",
  };
}

test("完整本地构建身份不会授予供应链、云或发布准入", () => {
  const result = assessNativeProof(proof());
  assert.equal(result.buildIdentityPassed, true);
  assert.equal(result.supplyChainValidated, false);
  assert.equal(result.cloudValidationEligible, false);
  assert.equal(result.publicationEligible, false);
});

test("源码树拒绝符号链接、子模块、路径穿越和重复条目", () => {
  const row = `100644 blob ${"a".repeat(40)}\tCargo.lock\0`;
  assert.equal(parseNativeTree(row).length, 1);
  for (const text of [
    row.replace("100644", "120000"),
    row.replace("100644 blob", "160000 commit"),
    row.replace("Cargo.lock", "../escape"),
    row + row,
  ])
    assert.throws(() => parseNativeTree(text));
});

test("缺少源码或 Git blob 改变拒绝", () => {
  for (const mutate of [
    (input) => {
      input.source = {};
    },
    (input) => {
      input.source["libclamav_rust/Cargo.toml"].gitBlob = "d".repeat(40);
    },
  ]) {
    const input = proof();
    mutate(input);
    assert.throws(() => assessNativeProof(input), /(?:NATIVE_SOURCE|SOURCE_EXPORT)/);
  }
});

test("编译不得联网或放松冻结锁文件", () => {
  for (const mutate of [
    (input) => {
      input.build.network = "default";
    },
    (input) => {
      input.command.offline = "false";
    },
    (input) => {
      input.command.args = ["build"];
    },
  ]) {
    const input = proof();
    mutate(input);
    assert.throws(() => assessNativeProof(input), /NATIVE_/);
  }
});

test("源码导出转换必须明确记账，不能把转换后字节冒充 canonical 字节", () => {
  for (const mutate of [
    (file) => {
      file.exportTransform = "unknown";
    },
    (file) => {
      file.rawGitBlob = "d".repeat(40);
    },
  ]) {
    const input = proof();
    mutate(input.source["libclamav_rust/Cargo.toml"]);
    assert.throws(() => assessNativeProof(input), /NATIVE_SOURCE_TRANSFORM/);
  }
});

test("Cargo 图拒绝未知编译包、重复包、漂移 Git 来源和缺失 vendor", () => {
  for (const mutate of [
    (input) => {
      input.rust[0].packageId = "unknown";
    },
    (input) => {
      input.metadata.packages.push(input.metadata.packages[0]);
    },
    (input) => {
      input.metadata.packages[1].source = "git+https://github.com/example/dep#main";
    },
    (input) => {
      input.vendor = {};
    },
  ]) {
    const input = proof();
    mutate(input);
    assert.throws(() => assessNativeProof(input), /NATIVE_/);
  }
});

test("缺失内置原生组件或缩减解析能力拒绝", () => {
  const input = proof();
  delete input.dependencies["/src/libclammspack/mspack.c"];
  assert.throws(() => assessNativeProof(input), /NATIVE_COMPONENT_MISSING/);
  const changed = proof();
  changed.cache = changed.cache.replace("ENABLE_UNRAR:BOOL=ON", "ENABLE_UNRAR:BOOL=OFF");
  assert.throws(() => assessNativeProof(changed), /NATIVE_CAPABILITY_CHANGED/);
});

test("运行引擎必须逐项匹配实际安装二进制摘要", () => {
  const input = proof();
  input.runtime.binaries["/usr/bin/clamscan"].sha256 = "b".repeat(64);
  assert.throws(() => assessNativeProof(input), /NATIVE_PRODUCT_BINARY_CHANGED/);
});

test("原生构建核验不能用合法 clamscan 身份替代其他引擎", () => {
  const input = proof();
  const scanner = input.runtime.binaries["/usr/bin/clamscan"];
  for (const name of Object.keys(input.runtime.binaries))
    input.runtime.binaries[name] = { ...scanner };
  assert.throws(() => assessNativeProof(input), /NATIVE_PRODUCT_BINARY_PATH_MISMATCH/);
});

test("原生构建核验必须从安装项解析链接，不能只信报告的终点", () => {
  const input = proof();
  const name = "/usr/lib/libclamav.so.12";
  const target = `${name}.1.0`;
  input.installed[name.slice(1)] = { link: "libclamav.so.12.1.0" };
  input.installed[target.slice(1)] = { sha256: digest };
  input.runtime.binaries[name] = { path: target, sha256: digest };
  assert.equal(assessNativeProof(input).buildIdentityPassed, true);
  for (const link of ["missing", "libclamav.so.12", "../lib/libclamav.so.12.1.0"]) {
    const changed = structuredClone(input);
    changed.installed[name.slice(1)] = { link };
    assert.throws(() => assessNativeProof(changed), /NATIVE_INSTALL_/);
  }
});

test("clean、EICAR、动态链接或探测隔离失败都拒绝", () => {
  for (const mutate of [
    (input) => {
      input.runtime.clean.status = 2;
    },
    (input) => {
      input.runtime.eicar.status = 0;
    },
    (input) => {
      input.runtime.eicar.stdout = "OK";
    },
    (input) => {
      input.runtime.linkedLibraries = "libmissing.so not found";
    },
    (input) => {
      input.runtime.network = "default";
    },
  ]) {
    const input = proof();
    mutate(input);
    assert.throws(() => assessNativeProof(input), /NATIVE_/);
  }
});

test("声明生产或供应链准入不能替代构建证明", () => {
  const input = proof();
  input.build.productionReady = true;
  assert.throws(() => assessNativeProof(input), /NATIVE_BUILD_CANNOT_GRANT/);
});

test("运行镜像不能包含编译工具链，也不能省略加载库摘要", () => {
  const input = proof();
  input.runtime.packages.push("cargo-1.96.1-r0");
  assert.throws(() => assessNativeProof(input), /NATIVE_COMPILER_IN_RUNTIME/);
  const missing = proof();
  missing.runtime.libraries = {};
  assert.throws(() => assessNativeProof(missing), /NATIVE_LOADED_LIBRARIES_MISSING/);
});

test("OOM、退出信号和超时错误不能冒充成功扫描", () => {
  for (const mutate of [
    (runtime) => {
      runtime.oomKilled = true;
    },
    (runtime) => {
      runtime.clean.signal = "SIGKILL";
    },
    (runtime) => {
      runtime.eicar.errorCode = "ETIMEDOUT";
    },
  ]) {
    const input = proof();
    mutate(input.runtime);
    assert.throws(() => assessNativeProof(input), /NATIVE_PROBE_/);
  }
});
