import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyNativeRuntime } from "./scanner-native-runtime-context.mjs";
import { artifactRoot, root, sourceFiles } from "./source-scope.mjs";

async function sourceHashes() {
  const sources = {};
  for (const file of await sourceFiles()) {
    sources[file] = createHash("sha256")
      .update(await readFile(path.join(root, file)))
      .digest("hex");
  }
  return sources;
}

function dryRun(config, output) {
  const result = spawnSync(
    process.execPath,
    [
      path.join(root, "node_modules/wrangler/bin/wrangler.js"),
      "deploy",
      "--dry-run",
      // Wrangler 的 dry-run 也会构建 Container；只打包 Worker 时显式禁止这项副作用。
      "--containers-rollout",
      "none",
      "--config",
      config,
      "--outdir",
      output,
    ],
    {
      cwd: root,
      encoding: "utf8",
      timeout: 120000,
      // 固定锁文件的本地构建不做 banner 的异步 npm 版本探测，避免代理 socket 阻止 CLI 退出。
      env: {
        ...process.env,
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_HIDE_BANNER: "true",
        CI: "true",
      },
    },
  );
  return result;
}

/** 只运行 dry-run，发布目录不可变；不给构建脚本任何真实部署分支。 */
export async function build(nativeDirectory) {
  const sources = await sourceHashes();
  await mkdir(artifactRoot, { recursive: true });
  const output = await mkdtemp(path.join(artifactRoot, "assetlibrary-p3-"));
  await mkdir(path.join(output, "scanner"));
  for (const [config, directory] of [
    ["wrangler.jsonc", output],
    ["scanner/wrangler.jsonc", path.join(output, "scanner")],
  ]) {
    const result = dryRun(config, directory);
    await writeFile(
      path.join(directory, "build.log"),
      `${result.stdout ?? ""}${result.stderr ?? ""}\n${JSON.stringify({ status: result.status, signal: result.signal, errorCode: result.error?.code })}\n`,
      "utf8",
    );
    if (result.error || result.status !== 0)
      throw new Error(`BUILD_FAILED: ${directory}/build.log`);
  }
  await mkdir(path.join(output, "db"));
  const migrations = (await readdir(path.join(root, "db")))
    .filter((name) => name.endsWith(".sql"))
    .sort();
  for (const name of migrations)
    await copyFile(path.join(root, "db", name), path.join(output, "db", name));
  const config = JSON.parse(await readFile(path.join(root, "wrangler.jsonc"), "utf8"));
  config.main = "index.js";
  await writeFile(path.join(output, "wrangler.json"), `${JSON.stringify(config, null, 2)}\n`);
  const scanner = JSON.parse(await readFile(path.join(root, "scanner/wrangler.jsonc"), "utf8"));
  scanner.main = "worker.js";
  await writeFile(
    path.join(output, "scanner/wrangler.json"),
    `${JSON.stringify(scanner, null, 2)}\n`,
  );
  const runtimeFiles = [
    "Dockerfile",
    ".dockerignore",
    "database.mjs",
    "process.mjs",
    "server.mjs",
    "limits.mjs",
  ];
  for (const name of runtimeFiles)
    await copyFile(path.join(root, "scanner", name), path.join(output, "scanner", name));
  if (nativeDirectory) await applyNativeRuntime(output, nativeDirectory);
  if (JSON.stringify(sources) !== JSON.stringify(await sourceHashes()))
    throw new Error(`SOURCE_CHANGED_DURING_BUILD: ${output}`);
  const artifacts = {};
  const webModules = (await readdir(output))
    .filter((file) =>
      /^[0-9a-f]{40}-(?:index\.html|style\.css|(?:app|api|render|upload|distribution|distribution-render|download)\.client\.js)$/.test(
        file,
      ),
    )
    .sort();
  if (webModules.length !== 9) throw new Error("WEB_MODULE_COVERAGE_INCOMPLETE");
  for (const file of [
    "index.js",
    "index.js.map",
    "README.md",
    "wrangler.json",
    ...webModules,
    ...["worker.js", "worker.js.map", "README.md", "wrangler.json", ...runtimeFiles].map(
      (name) => `scanner/${name}`,
    ),
    ...migrations.map((name) => `db/${name}`),
    ...(nativeDirectory ? ["scanner/install.tar", "scanner/native-install.json"] : []),
  ]) {
    artifacts[file] = createHash("sha256")
      .update(await readFile(path.join(output, file)))
      .digest("hex");
  }
  await writeFile(
    path.join(output, "manifest.json"),
    `${JSON.stringify(
      {
        format: 1,
        version: JSON.parse(await readFile(path.join(root, "package.json"), "utf8")).version,
        createdAt: new Date().toISOString(),
        stage: "P5-independent-review-queue-candidate",
        cloudDeployed: false,
        modules: Object.fromEntries(webModules.map((name) => [name, "text"])),
        sources,
        artifacts,
      },
      null,
      2,
    )}\n`,
  );
  console.log(`Worker artifact: ${output}`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await build();
