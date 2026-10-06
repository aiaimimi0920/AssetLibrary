import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sourceExportLayout } from "../scanner/native-build/source-exports.mjs";
import { verifyInstalledEngine } from "./scanner-native-installation.mjs";
import { sha256 } from "./scanner-release-policy.mjs";

/** 构建材料证明只回答实际输入/产物身份；不能自行授予漏洞、云或生产准入。 */
export function assessNativeProof({
  tree,
  source,
  vendor,
  metadata,
  rust,
  installed,
  dependencies,
  runtime,
  build,
  command,
  cache,
}) {
  assert.equal(build.version, "1.5.4", "NATIVE_VERSION_MISMATCH");
  assert.equal(build.network, "none", "NATIVE_BUILD_NETWORK_ENABLED");
  assert.equal(build.cargoFrozen, true, "NATIVE_CARGO_NOT_FROZEN");
  assert.equal(command.offline, "true", "NATIVE_CARGO_NETWORK_ENABLED");
  assert(command.args.includes("--frozen"), "NATIVE_CARGO_LOCK_NOT_ENFORCED");
  assert.equal(build.productionReady, false, "NATIVE_BUILD_CANNOT_GRANT_PRODUCTION");
  assert.equal(build.supplyChainValidated, false, "NATIVE_BUILD_CANNOT_GRANT_SUPPLY_CHAIN");
  for (const [option, value] of Object.entries({
    ENABLE_UNRAR: "ON",
    ENABLE_LIBCLAMAV_ONLY: "OFF",
    ENABLE_EXTERNAL_MSPACK: "OFF",
    BYTECODE_RUNTIME: "interpreter",
    ENABLE_JSON_SHARED: "ON",
  }))
    assert(
      new RegExp(`^${option}:[^=]+=${value}$`, "m").test(cache),
      `NATIVE_CAPABILITY_CHANGED:${option}`,
    );
  const layout = sourceExportLayout(tree, Object.keys(source));
  for (const entry of layout.exported) {
    const file = source[entry.path];
    assert.equal(file.gitBlob, entry.blob, "NATIVE_SOURCE_BLOB_MISMATCH");
    assert.match(file.sha256, /^[0-9a-f]{64}$/, "NATIVE_SOURCE_DIGEST_INVALID");
    assert.match(file.rawGitBlob, /^[0-9a-f]{40}$/, "NATIVE_SOURCE_RAW_BLOB_INVALID");
    assert(
      ["none", "windows-git-archive-crlf"].includes(file.exportTransform),
      "NATIVE_SOURCE_TRANSFORM_UNKNOWN",
    );
    assert.equal(
      file.rawGitBlob === file.gitBlob,
      file.exportTransform === "none",
      "NATIVE_SOURCE_TRANSFORM_IDENTITY_MISMATCH",
    );
  }
  assert(Object.keys(vendor).length > 0, "NATIVE_VENDOR_MISSING");
  assert(
    metadata.packages?.length > 0 && metadata.resolve?.nodes?.length > 0,
    "NATIVE_CARGO_METADATA_MISSING",
  );
  const packages = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]));
  assert.equal(packages.size, metadata.packages.length, "NATIVE_CARGO_PACKAGE_DUPLICATED");
  for (const pkg of packages.values()) {
    if (pkg.source?.startsWith("git+"))
      assert(/#[0-9a-f]{40}$/.test(pkg.source), "NATIVE_GIT_DEPENDENCY_UNPINNED");
    const manifest = pkg.manifest_path?.replace(/^\/src\//, "");
    assert(
      manifest && (source[manifest] || vendor[manifest.replace(/^\.cargo\//, "")]),
      "NATIVE_CARGO_SOURCE_MISSING",
    );
  }
  assert(rust.length > 0, "NATIVE_RUST_ARTIFACTS_MISSING");
  for (const artifact of rust) {
    assert(packages.has(artifact.packageId), "NATIVE_COMPILED_PACKAGE_UNKNOWN");
    assert(Object.keys(artifact.files).length > 0, "NATIVE_RUST_FILES_MISSING");
    for (const digest of Object.values(artifact.files))
      assert.match(digest, /^[0-9a-f]{64}$/, "NATIVE_RUST_DIGEST_INVALID");
  }
  assert(
    rust.some(
      (entry) =>
        entry.target.name === "clamav_rust" && entry.target.crate_types.includes("staticlib"),
    ),
    "NATIVE_STATIC_RUST_MISSING",
  );
  for (const component of ["libclamav", "libclammspack", "libclamunrar"])
    assert(
      Object.keys(dependencies).some((file) => file.includes(`/${component}/`)),
      `NATIVE_COMPONENT_MISSING:${component}`,
    );
  assert.equal(runtime.network, "none", "NATIVE_PROBE_NETWORK_ENABLED");
  assert.equal(runtime.oomKilled, false, "NATIVE_PROBE_OOM");
  for (const result of [runtime.clean, runtime.eicar]) {
    assert.equal(result.signal ?? null, null, "NATIVE_PROBE_SIGNAL");
    assert.equal(result.errorCode ?? null, null, "NATIVE_PROBE_PROCESS_ERROR");
  }
  assert(runtime.packages?.length > 0, "NATIVE_RUNTIME_PACKAGES_MISSING");
  assert(
    !runtime.packages.some((pkg) => /^(cargo|rust|gcc|g\+\+|cmake)-/.test(pkg)),
    "NATIVE_COMPILER_IN_RUNTIME",
  );
  assert(Object.keys(runtime.libraries ?? {}).length > 0, "NATIVE_LOADED_LIBRARIES_MISSING");
  for (const digest of Object.values(runtime.libraries))
    assert.match(digest, /^[0-9a-f]{64}$/, "NATIVE_LOADED_LIBRARY_DIGEST_INVALID");
  assert.match(runtime.version, /^ClamAV 1\.5\.4\//, "NATIVE_RUNTIME_VERSION_MISMATCH");
  assert.equal(runtime.clean.status, 0, "NATIVE_CLEAN_FAILED");
  assert.equal(runtime.eicar.status, 1, "NATIVE_EICAR_FAILED");
  assert.match(runtime.eicar.stdout, /Eicar.*FOUND/i, "NATIVE_EICAR_NOT_DETECTED");
  assert(
    !/not found|Error loading|Error relocating/.test(runtime.linkedLibraries),
    "NATIVE_LINK_FAILURE",
  );
  verifyInstalledEngine(installed, runtime.binaries ?? {});
  return {
    buildIdentityPassed: true,
    sourceFiles: tree.length,
    exportedSourceFiles: layout.exported.length,
    omittedGitMetadata: layout.omitted.length,
    transformedSourceFiles: Object.values(source).filter((file) => file.exportTransform !== "none")
      .length,
    cargoResolvedPackages: packages.size,
    compiledRustPackages: new Set(rust.map((entry) => entry.packageId)).size,
    nativeInputs: Object.keys(dependencies).length,
    installedFiles: Object.keys(installed).length,
    supplyChainValidated: false,
    cloudValidationEligible: false,
    publicationEligible: false,
    blockers: [
      "NATIVE_COMPONENT_VULNERABILITY_REVIEW_PENDING",
      "NEW_IMAGE_FULL_VULNERABILITY_SCAN_PENDING",
      "NEW_IMAGE_CLOUD_VALIDATION_PENDING",
    ],
  };
}

export async function verifyNativeProof(output) {
  const evidence = path.join(output, "proof/evidence");
  const json = async (name) => JSON.parse(await readFile(path.join(evidence, name), "utf8"));
  const input = await json("build-proof.json");
  assert.equal(
    sha256(await readFile(path.join(evidence, "install.tar"))),
    input.installArchiveSha256,
    "NATIVE_INSTALL_ARCHIVE_CHANGED",
  );
  return assessNativeProof({
    tree: await json("source-tree.json"),
    source: await json("source-files.json"),
    vendor: await json("vendor-files.json"),
    metadata: await json("cargo-metadata.json"),
    rust: await json("rust-artifacts.json"),
    installed: await json("installed-files.json"),
    dependencies: await json("native-dependencies.json"),
    command: await json("cargo-command.json"),
    cache: await readFile(path.join(evidence, "CMakeCache.txt"), "utf8"),
    runtime: JSON.parse(await readFile(path.join(output, "runtime.json"), "utf8")),
    build: input,
  });
}

export async function nativeProofFiles(output) {
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(path.join(output, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      assert(!entry.isSymbolicLink(), "NATIVE_EVIDENCE_LINK_FORBIDDEN");
      if (entry.isDirectory()) await walk(relative);
      else {
        assert(entry.isFile(), "NATIVE_EVIDENCE_SPECIAL_FILE");
        assert(
          (await stat(path.join(output, relative))).size <= 268435456,
          "NATIVE_EVIDENCE_FILE_LIMIT",
        );
        files[relative] = sha256(await readFile(path.join(output, relative)));
        assert(Object.keys(files).length <= 10000, "NATIVE_EVIDENCE_COUNT_LIMIT");
      }
    }
  }
  await walk("context");
  await walk("proof");
  for (const entry of await readdir(output, { withFileTypes: true }))
    if (entry.isFile() && entry.name !== "receipt.json")
      files[entry.name] = sha256(await readFile(path.join(output, entry.name)));
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [output, ...extra] = process.argv.slice(2);
  assert(output && !extra.length, "USAGE: scanner:native-assess <native-build-directory>");
  const receipt = JSON.parse(await readFile(path.join(output, "receipt.json"), "utf8"));
  assert.deepEqual(await nativeProofFiles(output), receipt.files, "NATIVE_EVIDENCE_CHANGED");
  console.log(JSON.stringify(await verifyNativeProof(output), null, 2));
}
