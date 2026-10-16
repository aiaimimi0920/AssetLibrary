import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { readInside } from "./package-input.mjs";
import { root } from "./source-scope.mjs";

// 只做本地结构预检，不上传、不运行载荷，不授予发布或安装资格。
const [kind, input, ...extra] = process.argv.slice(2);
if (!["art", "capability"].includes(kind) || !input || extra.length)
  throw new Error("USAGE: node scripts/preflight-loom-package.mjs <art|capability> <zip>");
const source = path.resolve(input);
const bytes = await readInside(
  await realpath(path.dirname(source)),
  path.basename(source),
  8388608,
);
const output = await mkdtemp(path.resolve(root, "../../linshi/assetlibrary-loom-preflight-"));
const compiled = path.join(output, "compiled");
await mkdir(compiled);
const build = spawnSync(
  process.execPath,
  [
    path.join(root, "node_modules/typescript/bin/tsc"),
    "--project",
    "tsconfig.json",
    "--noEmit",
    "false",
    "--module",
    "CommonJS",
    "--moduleResolution",
    "Node",
    "--outDir",
    compiled,
  ],
  { cwd: root, encoding: "utf8", timeout: 30000 },
);
await writeFile(
  path.join(output, "compile.log"),
  `${build.stdout ?? ""}${build.stderr ?? ""}`,
  "utf8",
);
if (build.error || build.status !== 0) throw new Error(`PREFLIGHT_COMPILE_FAILED: ${output}`);
await writeFile(path.join(compiled, "package.json"), '{"type":"commonjs"}\n', "utf8");
const require = createRequire(path.join(compiled, "preflight.cjs"));
const { inspectLoomPackage } = require(path.join(compiled, "packages/loom.js"));
try {
  const structure = await inspectLoomPackage(bytes, kind);
  // 输出完整原包，不序列化清单、不重打包，以免破坏宿主签名。
  await writeFile(path.join(output, "package.zip"), bytes, { flag: "wx" });
  const receipt = {
    schema: "loom-package-preflight-v1",
    generatedAt: new Date().toISOString(),
    source,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    structure,
    originalBytesPreserved: true,
    signatureVerified: false,
    scanned: false,
    productionEligible: false,
    hostInstallVerified: false,
  };
  await writeFile(
    path.join(output, "receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    "utf8",
  );
  console.log(`Native package structure passed (not scan/signature/install approval): ${output}`);
} catch (error) {
  await writeFile(
    path.join(output, "failure.json"),
    `${JSON.stringify({ error: error.message })}\n`,
    "utf8",
  );
  throw error;
}
