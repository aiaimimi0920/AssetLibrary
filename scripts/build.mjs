import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { applyNativeRuntime } from "./scanner-native-runtime-context.mjs";
import { artifactRoot, root, sourceFiles } from "./source-scope.mjs";

const wranglerRequire = createRequire(
  realpathSync(path.join(root, "node_modules/wrangler/package.json")),
);
const blake3 = wranglerRequire("blake3-wasm");

const STATIC_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self' https://naccount-auth.aiaimimi.com; frame-ancestors 'none'";

const STATIC_HEADERS_TEXT = [
  "/*",
  "  X-Content-Type-Options: nosniff",
  "  Referrer-Policy: same-origin",
  `  Content-Security-Policy: ${STATIC_CSP}`,
  "  Permissions-Policy: camera=(), microphone=(), geolocation=()",
  "",
  "/",
  "  Cache-Control: public, max-age=60, stale-while-revalidate=300",
  "",
  "/workspace",
  "  Cache-Control: public, max-age=60, stale-while-revalidate=300",
  "",
  "/*.css",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
  "/*.js",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
  "/beaver.svg",
  "  Cache-Control: public, max-age=31536000, immutable",
  "",
].join("\n");

function staticContentType(routePath) {
  if (routePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (routePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (routePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (routePath.endsWith(".svg")) return "image/svg+xml; charset=utf-8";
  throw new Error(`UNSUPPORTED_STATIC_ASSET: ${routePath}`);
}

function shortDigest(bytes) {
  return createHash("sha256").update(bytes).digest("hex").slice(0, 12);
}

async function buildStaticAssets(output) {
  const publicDir = path.join(output, "public");
  await mkdir(publicDir, { recursive: true });
  const webEntries = (await readdir(path.join(root, "src/web"))).sort();
  const rawSources = new Map();
  for (const name of webEntries) {
    if (!/\.(?:html|css|svg|client\.js)$/.test(name)) continue;
    const targetName =
      name === "store.html" ? "index.html" : name === "index.html" ? "workspace.html" : name;
    rawSources.set(targetName, await readFile(path.join(root, "src/web", name)));
  }
  if (rawSources.size !== 20) throw new Error("STATIC_ASSET_COVERAGE_INCOMPLETE");

  // 先对静态样式/图标及 ESM 模块图收敛计算 12 位内容指纹，使 HTML 与相对 import 共享完全一致的 ?v= 缓存键。
  const versions = new Map();
  const rendered = new Map(rawSources);
  for (const [name, buf] of rawSources) {
    if (!name.endsWith(".html")) versions.set(name, shortDigest(buf));
  }
  for (let pass = 0; pass < 4; pass++) {
    for (const [name, buf] of rawSources) {
      if (!name.endsWith(".client.js")) continue;
      const rewrittenJs = buf
        .toString("utf8")
        .replace(/from "\.\/([a-z-]+\.client\.js)"/g, (_match, dep) => {
          const ver = versions.get(dep);
          if (!ver) throw new Error(`UNKNOWN_STATIC_DEP: ${dep}`);
          return `from "./${dep}?v=${ver}"`;
        });
      const outBuf = Buffer.from(rewrittenJs, "utf8");
      rendered.set(name, outBuf);
      versions.set(name, shortDigest(outBuf));
    }
  }
  for (const htmlName of ["index.html", "workspace.html"]) {
    const rewrittenHtml = rawSources
      .get(htmlName)
      .toString("utf8")
      .replace(
        /\b(href|src)="\/([a-z-]+(?:\.client\.js|\.css|\.svg))"/g,
        (_match, attr, assetName) => {
          const ver = versions.get(assetName);
          if (!ver) throw new Error(`UNKNOWN_HTML_ASSET: ${assetName}`);
          return `${attr}="/${assetName}?v=${ver}"`;
        },
      );
    rendered.set(htmlName, Buffer.from(rewrittenHtml, "utf8"));
  }

  const files = {};
  for (const targetName of [...rendered.keys()].sort()) {
    const raw = rendered.get(targetName);
    await writeFile(path.join(publicDir, targetName), raw);
    const ext = path.extname(targetName).slice(1);
    const hash = blake3
      .hash(raw.toString("base64") + ext)
      .toString("hex")
      .slice(0, 32);
    const sha256 = createHash("sha256").update(raw).digest("hex");
    const routePath = `/${targetName}`;
    files[routePath] = {
      file: `public/${targetName}`,
      hash,
      size: raw.byteLength,
      sha256,
      contentType: staticContentType(routePath),
    };
  }
  return {
    files,
    config: {
      html_handling: "auto-trailing-slash",
      not_found_handling: "none",
      _headers: STATIC_HEADERS_TEXT,
    },
  };
}

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
      /^[0-9a-f]{40}-(?:(?:index|store)\.html|(?:style|store|store-shell|asset-market)\.css|beaver\.svg|(?:store|store-view|asset-market|app|api|render|upload|distribution|distribution-render|download|resume-download|resource|showcase)\.client\.js)$/.test(
        file,
      ),
    )
    .sort();
  if (webModules.length !== 20) throw new Error("WEB_MODULE_COVERAGE_INCOMPLETE");
  const staticAssets = await buildStaticAssets(output);
  for (const file of [
    "index.js",
    "index.js.map",
    "README.md",
    "wrangler.json",
    ...webModules,
    ...Object.values(staticAssets.files).map((entry) => entry.file),
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
        stage: "P3-software-packages-local-candidate",
        cloudDeployed: false,
        modules: Object.fromEntries(webModules.map((name) => [name, "text"])),
        staticAssets,
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
