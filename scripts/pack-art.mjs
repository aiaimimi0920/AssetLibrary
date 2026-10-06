import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, open, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { artZip } from "./art-package-zip.mjs";
import { artifactRoot } from "./source-scope.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
function inputPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 180 ||
    value.split("/").length > 4 ||
    value
      .split("/")
      .some(
        (part) =>
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) ||
          part.endsWith(".") ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("PACKAGE_PATH_INVALID");
  return value;
}

async function readInside(root, name, limit) {
  const filename = path.join(root, inputPath(name));
  const initial = await lstat(filename, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("PACKAGE_INPUT_NOT_FILE");
  const resolved = await realpath(filename);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("PACKAGE_INPUT_OUTSIDE_ROOT");
  const handle = await open(resolved, "r");
  try {
    const stat = await handle.stat({ bigint: true });
    // 绑定实际打开对象，不只相信 open 前解析的路径；源目录仍须由调用者控制。
    if (stat.dev !== initial.dev || stat.ino !== initial.ino)
      throw new Error("PACKAGE_INPUT_CHANGED");
    if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(limit))
      throw new Error("PACKAGE_INPUT_SIZE_LIMIT");
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (
      BigInt(size) !== stat.size ||
      final.size !== stat.size ||
      final.mtimeNs !== stat.mtimeNs ||
      final.ctimeNs !== stat.ctimeNs
    )
      throw new Error("PACKAGE_INPUT_CHANGED");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}

/** 仅从明确列举的本地 PNG 生成候选包；打包成功不是内容检查通过。 */
export async function packArt(inputDirectory) {
  if (!inputDirectory) throw new Error("USAGE: pnpm pack:art <input-directory>");
  const root = await realpath(path.resolve(inputDirectory));
  const recipeBytes = await readInside(root, "art-package.json", 32768);
  if (recipeBytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])))
    throw new Error("PACKAGE_RECIPE_BOM");
  const recipe = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(recipeBytes));
  if (
    !recipe ||
    Array.isArray(recipe) ||
    Object.keys(recipe).length !== 1 ||
    !Array.isArray(recipe.files) ||
    recipe.files.length < 1 ||
    recipe.files.length > 32
  )
    throw new Error("PACKAGE_RECIPE_INVALID");
  const names = new Set();
  const entries = [];
  const files = [];
  let total = 0;
  let pixels = 0;
  for (const value of recipe.files) {
    const name = inputPath(value);
    const folded = name.toLowerCase();
    if (
      !folded.endsWith(".png") ||
      folded.startsWith("manifest.json/") ||
      [...names].some(
        (prior) =>
          prior === folded || prior.startsWith(`${folded}/`) || folded.startsWith(`${prior}/`),
      )
    )
      throw new Error("PACKAGE_RECIPE_INVALID");
    names.add(folded);
    const bytes = await readInside(root, name, 1048576);
    if (
      bytes.length < 33 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.subarray(12, 16).toString("ascii") !== "IHDR"
    )
      throw new Error("PACKAGE_PNG_HEADER_INVALID");
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    pixels += width * height;
    total += bytes.length;
    if (!width || !height || width > 2048 || height > 2048 || pixels > 1048576 || total > 8388608)
      throw new Error("PACKAGE_BUDGET_EXCEEDED");
    entries.push({ path: name, bytes });
    files.push({ path: name, size: bytes.length, sha256: hash(bytes), mediaType: "image/png" });
  }
  const manifest = Buffer.from(
    `${JSON.stringify({ schema: "neuro-art-package-v1", files })}\n`,
    "utf8",
  );
  if (manifest.length > 32768 || total + manifest.length > 8388608)
    throw new Error("PACKAGE_BUDGET_EXCEEDED");
  // PNG 本身已压缩；默认 Stored 避免无收益的嵌套解压和膨胀比拒绝。
  const archive = artZip([{ path: "manifest.json", bytes: manifest }, ...entries], 0);
  if (archive.length > 8388608) throw new Error("PACKAGE_BUDGET_EXCEEDED");
  await mkdir(artifactRoot, { recursive: true });
  const output = await mkdtemp(path.join(artifactRoot, "assetlibrary-art-package-"));
  const receipt = {
    policy: "art-zip-manifest-v1",
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
  if (process.argv.length !== 3) throw new Error("USAGE: pnpm pack:art <input-directory>");
  console.log(JSON.stringify(await packArt(process.argv[2]), null, 2));
}
