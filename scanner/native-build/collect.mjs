import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  readdir,
  readFile,
  readlink,
  realpath,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { bindSourceBlob, sourceExportLayout } from "./source-exports.mjs";

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = async (file) => JSON.parse(await readFile(file, "utf8"));
const save = async (name, value) =>
  writeFile(`/evidence/${name}`, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
const run = (command, args) => execFileSync(command, args, { encoding: "utf8", timeout: 30000 });

async function inventory(root, skip = []) {
  const files = {};
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (skip.includes(relative)) continue;
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isSymbolicLink())
        files[relative] = { link: await readlink(path.join(root, relative)) };
      else {
        assert(entry.isFile(), "INPUT_SPECIAL_FILE");
        const bytes = await readFile(path.join(root, relative));
        files[relative] = { bytes: bytes.length, sha256: digest(bytes) };
      }
    }
  }
  await walk("");
  return files;
}

if (process.argv[2] === "inputs") {
  const tree = await json("/opt/native/source-tree.json");
  const source = await inventory("/src", [".cargo"]);
  const layout = sourceExportLayout(tree, Object.keys(source));
  const generated = {};
  for (const name of layout.generated) {
    generated[name] = source[name];
    delete source[name];
  }
  await save("source-export.json", { omittedGitMetadata: layout.omitted, generated });
  for (const entry of layout.exported) {
    assert(["100644", "100755"].includes(entry.mode), "SOURCE_MODE_UNSUPPORTED");
    const bytes = await readFile(`/src/${entry.path}`);
    Object.assign(source[entry.path], bindSourceBlob(bytes, entry.blob));
  }
  await save("source-files.json", source);
  await copyFile("/opt/native/source-tree.json", "/evidence/source-tree.json");
  await save("vendor-files.json", await inventory("/src/.cargo"));
  const tools = {};
  for (const name of ["cc", "c++", "cmake", "make", "rustc", "cargo", "ld"]) {
    const resolved = await realpath(`/usr/bin/${name}`);
    tools[name] = {
      path: resolved,
      sha256: digest(await readFile(resolved)),
      version: run(name, ["--version"]),
    };
  }
  await save("toolchain.json", {
    tools,
    packages: run("apk", ["--no-network", "info", "-v"]).trim().split("\n").sort(),
    apkDatabaseSha256: digest(await readFile("/lib/apk/db/installed")),
  });
  await save("recipe-files.json", await inventory("/opt/native"));
} else {
  assert.equal(process.argv[2], "outputs", "COLLECT_PHASE_INVALID");
  const messages = (await readFile("/evidence/cargo-artifacts.jsonl", "utf8"))
    .trim()
    .split("\n")
    .map(JSON.parse);
  assert(
    messages.some((message) => message.reason === "build-finished" && message.success),
    "CARGO_BUILD_NOT_FINISHED",
  );
  const rust = [];
  for (const message of messages.filter((message) => message.reason === "compiler-artifact")) {
    const files = {};
    for (const file of message.filenames) files[file] = digest(await readFile(file));
    rust.push({
      packageId: message.package_id,
      target: message.target,
      features: message.features,
      files,
    });
  }
  assert(
    rust.some(
      (entry) =>
        entry.target.name === "clamav_rust" && entry.target.crate_types.includes("staticlib"),
    ),
    "RUST_STATICLIB_MISSING",
  );
  await save("rust-artifacts.json", rust);
  for (const name of ["CMakeCache.txt", "compile_commands.json", "install_manifest.txt"])
    await copyFile(`/build/${name}`, `/evidence/${name}`);
  const dependencies = {};
  const dependencyFiles = [];
  async function findDependencies(directory) {
    for (const entry of await readdir(`/build/${directory}`, { withFileTypes: true })) {
      const relative = path.posix.join(directory, entry.name);
      if (entry.isDirectory()) await findDependencies(relative);
      else if (entry.isFile() && relative.endsWith(".o.d")) dependencyFiles.push(relative);
    }
  }
  await findDependencies("");
  for (const name of dependencyFiles) {
    const text = await readFile(`/build/${name}`, "utf8");
    for (const file of text.replace(/\\\n/g, " ").split(/\s+/).slice(1)) {
      if (!file || file.endsWith(":")) continue;
      const resolved = path.resolve("/build", file);
      assert(
        resolved.startsWith("/src/") ||
          resolved.startsWith("/usr/") ||
          resolved.startsWith("/build/"),
        "COMPILE_INPUT_PATH_INVALID",
      );
      const stat = await lstat(resolved);
      if (stat.isFile() || stat.isSymbolicLink())
        dependencies[resolved] = digest(await readFile(resolved));
    }
  }
  assert(
    Object.keys(dependencies).some((file) => file.includes("/libclamav/")),
    "NATIVE_INPUTS_MISSING",
  );
  assert(
    Object.keys(dependencies).some((file) => file.includes("/libclammspack/")),
    "MSPACK_INPUTS_MISSING",
  );
  await save("native-dependencies.json", dependencies);
  await save("installed-files.json", await inventory("/install"));
  run("tar", ["-cf", "/evidence/install.tar", "-C", "/install", "."]);
  assert.equal(
    digest(await readFile("/src/Cargo.lock")),
    (await json("/evidence/source-files.json"))["Cargo.lock"].sha256,
    "CARGO_LOCK_CHANGED",
  );
  await save("build-proof.json", {
    format: 1,
    version: "1.5.4",
    network: "none",
    cargoFrozen: true,
    installArchiveSha256: digest(await readFile("/evidence/install.tar")),
    productionReady: false,
    supplyChainValidated: false,
  });
}
