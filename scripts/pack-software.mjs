import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artZip as packageZip } from "./art-package-zip.mjs";
import { inputPath, readInside } from "./package-input.mjs";
import { artifactRoot } from "./source-scope.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** 仅绑定明确列出的原字节；不执行载荷，不证明签名、安装或运行安全。 */
export async function packSoftware(inputDirectory, { largeApplication = false } = {}) {
  if (!inputDirectory) throw new Error("USAGE: pnpm pack:software <input-directory>");
  const root = await realpath(path.resolve(inputDirectory));
  const recipeBytes = await readInside(root, "software-package.json", 32768);
  if (recipeBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    throw new Error("PACKAGE_RECIPE_BOM");
  const recipe = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recipeBytes));
  if (
    !recipe ||
    Array.isArray(recipe) ||
    Object.keys(recipe).length !== 2 ||
    !["capability", "application", "mcp"].includes(recipe.kind) ||
    !Array.isArray(recipe.files) ||
    recipe.files.length < 1 ||
    recipe.files.length > (largeApplication ? 64 : 32) ||
    (largeApplication && recipe.kind !== "application")
  )
    throw new Error("PACKAGE_RECIPE_INVALID");
  const names = new Set(["manifest.json"]);
  const entries = [];
  const files = [];
  let total = 0;
  const unpackedLimit = largeApplication ? 256 * 1024 * 1024 : 8388608;
  for (const value of recipe.files) {
    const name = inputPath(value);
    const folded = name.toLowerCase();
    if (
      [...names].some(
        (prior) =>
          prior === folded || prior.startsWith(`${folded}/`) || folded.startsWith(`${prior}/`),
      )
    )
      throw new Error("PACKAGE_RECIPE_INVALID");
    names.add(folded);
    const fileLimit = largeApplication ? 128 * 1024 * 1024 : 1048576;
    const bytes = await readInside(
      root,
      name,
      largeApplication && name === "application.json" ? 32768 : fileLimit,
    );
    total += bytes.length;
    if (total > unpackedLimit) throw new Error("PACKAGE_BUDGET_EXCEEDED");
    entries.push({ path: name, bytes });
    files.push({ path: name, size: bytes.length, sha256: hash(bytes) });
  }
  const manifest = Buffer.from(
    `${JSON.stringify({ schema: "neuro-software-package-v1", kind: recipe.kind, files })}\n`,
    "utf8",
  );
  if (manifest.length > 32768 || total + manifest.length > unpackedLimit)
    throw new Error("PACKAGE_BUDGET_EXCEEDED");
  // 小包保持 Stored；显式大应用模式仅在压缩更小且膨胀比不超过 100 时使用 Deflate。
  const archive = packageZip(
    [{ path: "manifest.json", bytes: manifest }, ...entries],
    largeApplication ? "bounded-auto" : 0,
  );
  if (archive.length > (largeApplication ? 96_000_000 : 8388608))
    throw new Error("PACKAGE_BUDGET_EXCEEDED");
  await mkdir(artifactRoot, { recursive: true });
  const output = await mkdtemp(path.join(artifactRoot, "assetlibrary-software-package-"));
  const receipt = {
    kind: recipe.kind,
    policy: largeApplication ? "application-large-zip-format-v1" : `${recipe.kind}-zip-format-v1`,
    size: archive.length,
    sha256: hash(archive),
    files: files.length,
  };
  await writeFile(path.join(output, "package.zip"), archive, { flag: "wx" });
  await writeFile(path.join(output, "manifest.json"), manifest, { flag: "wx" });
  await writeFile(
    path.join(output, "package-receipt.json"),
    `${JSON.stringify(receipt, null, 2)}\n`,
    { encoding: "utf8", flag: "wx" },
  );
  return { output, ...receipt };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (
    process.argv.length < 3 ||
    process.argv.length > 4 ||
    (process.argv[3] && process.argv[3] !== "--large-application")
  )
    throw new Error("USAGE: pnpm pack:software <input-directory> [--large-application]");
  console.log(
    JSON.stringify(
      await packSoftware(process.argv[2], {
        largeApplication: process.argv[3] === "--large-application",
      }),
      null,
      2,
    ),
  );
}
