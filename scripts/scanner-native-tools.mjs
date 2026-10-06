import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, openSync, writeSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { prepareCmakeMaterial } from "./scanner-native-materials.mjs";
import { sha256 } from "./scanner-release-policy.mjs";
import { root } from "./source-scope.mjs";

export const nativeRevision = "fa59fca15872bb8a914ba4c68188bcc8a502cbdf";
export const nativeBase =
  "clamav/clamav@sha256:ebec5bc138401b36ae987caa1a3fa3c3b2a21ed3d51f0bfa5852825e663e67b0";

/** 固定 argv，不使用 shell 或开发机 RTK 包装；日志、网络和编译等待均有上界。 */
export async function nativeCommand(args, output, name, timeout = 90000) {
  assert(/^[a-z0-9-]+$/.test(name), "NATIVE_LOG_NAME_INVALID");
  const options = {
    cwd: output,
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")),
      ),
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  };
  const fd = openSync(path.join(output, `${name}.log`), "wx");
  console.log(`Native step: ${name}`);
  try {
    return await new Promise((resolve, reject) => {
      const child = spawn(args[0], args.slice(1), options);
      const chunks = [];
      let bytes = 0;
      let failure;
      function stop(reason) {
        if (failure) return;
        failure = reason;
        // Windows 的 kill 不回收后代：只终止本次已知 PID 的进程树，不扫其他任务。
        if (child.pid && process.platform === "win32")
          spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            timeout: 10000,
            stdio: "ignore",
          });
        else child.kill("SIGKILL");
      }
      const timer = setTimeout(() => stop("TIMEOUT"), timeout);
      function log(chunk, stdout) {
        bytes += chunk.length;
        if (bytes > 33554432) return stop("OUTPUT_LIMIT");
        writeSync(fd, chunk);
        if (stdout) chunks.push(chunk);
      }
      child.stdin.end();
      child.stdout.on("data", (chunk) => log(chunk, true));
      child.stderr.on("data", (chunk) => log(chunk, false));
      child.on("error", () => {
        failure = "SPAWN_ERROR";
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        if (failure || code !== 0)
          reject(new Error(`NATIVE_COMMAND_FAILED:${name}:${failure ?? code}`));
        else resolve(Buffer.concat(chunks).toString("utf8").trim());
      });
    });
  } finally {
    closeSync(fd);
  }
}

export function parseNativeTree(text) {
  const entries = text
    .split("\0")
    .filter(Boolean)
    .map((record) => {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(record);
      assert(match, "NATIVE_SOURCE_TREE_UNSUPPORTED");
      const name = match[3];
      assert(
        !name.startsWith("/") &&
          !name.split("/").some((part) => ["", ".", ".."].includes(part)) &&
          !name.includes("\\"),
        "NATIVE_SOURCE_PATH_INVALID",
      );
      return { mode: match[1], blob: match[2], path: name };
    });
  assert(entries.length > 0 && entries.length <= 10000, "NATIVE_SOURCE_TREE_SIZE");
  assert.equal(
    new Set(entries.map((entry) => entry.path)).size,
    entries.length,
    "NATIVE_SOURCE_DUPLICATE",
  );
  return entries;
}

export async function prepareNativeContext(output, cmakeFile, sourceRepository) {
  const repository = path.join(output, "upstream");
  const context = path.join(output, "context");
  await mkdir(context);
  await nativeCommand(["git", "init", repository], output, "git-init");
  await nativeCommand(
    [
      "git",
      "-C",
      repository,
      "-c",
      "core.hooksPath=NUL",
      "fetch",
      "--depth=1",
      sourceRepository
        ? path.resolve(sourceRepository)
        : "https://github.com/Cisco-Talos/clamav.git",
      nativeRevision,
    ],
    output,
    "git-fetch",
  );
  assert.equal(
    await nativeCommand(
      ["git", "-C", repository, "rev-parse", "FETCH_HEAD"],
      output,
      "git-revision",
    ),
    nativeRevision,
    "NATIVE_REVISION_CHANGED",
  );
  const tree = parseNativeTree(
    await nativeCommand(
      ["git", "-C", repository, "ls-tree", "-rz", nativeRevision],
      output,
      "git-tree",
    ),
  );
  await writeFile(path.join(context, "source-tree.json"), `${JSON.stringify(tree, null, 2)}\n`, {
    flag: "wx",
  });
  await nativeCommand(
    [
      "git",
      "-C",
      repository,
      "archive",
      "--format=tar",
      `--output=${path.join(context, "source.tar")}`,
      nativeRevision,
    ],
    output,
    "git-archive",
  );
  const recipe = {};
  for (const file of [
    "Dockerfile",
    "collect.mjs",
    "source-exports.mjs",
    "cargo-record.mjs",
    "runtime-probe.mjs",
  ]) {
    await copyFile(path.join(root, "scanner/native-build", file), path.join(context, file));
    recipe[file] = sha256(await readFile(path.join(context, file)));
  }
  const cmake = await prepareCmakeMaterial(context, cmakeFile);
  return {
    context,
    source: {
      repository: "https://github.com/Cisco-Talos/clamav.git",
      retrieval: sourceRepository
        ? { localObjectCache: path.resolve(sourceRepository) }
        : "upstream",
      revision: nativeRevision,
      files: tree.length,
      archiveSha256: sha256(await readFile(path.join(context, "source.tar"))),
      treeSha256: sha256(await readFile(path.join(context, "source-tree.json"))),
    },
    recipe,
    cmake,
  };
}

export async function verifyNativeContext(input) {
  assert.equal(
    sha256(await readFile(path.join(input.context, "cmake.apk"))),
    input.cmake.sha256,
    "CMAKE_CONTEXT_CHANGED",
  );
  for (const [file, digest] of Object.entries(input.recipe)) {
    assert.equal(
      sha256(await readFile(path.join(root, "scanner/native-build", file))),
      digest,
      "NATIVE_RECIPE_CHANGED",
    );
    assert.equal(
      sha256(await readFile(path.join(input.context, file))),
      digest,
      "NATIVE_CONTEXT_RECIPE_CHANGED",
    );
  }
  assert.equal(
    sha256(await readFile(path.join(input.context, "source.tar"))),
    input.source.archiveSha256,
    "NATIVE_SOURCE_ARCHIVE_CHANGED",
  );
  assert.equal(
    sha256(await readFile(path.join(input.context, "source-tree.json"))),
    input.source.treeSha256,
    "NATIVE_CONTEXT_TREE_CHANGED",
  );
}
