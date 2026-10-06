import { readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const root = fileURLToPath(new URL("../", import.meta.url));
export const artifactRoot = path.resolve(root, "../../linshi");
const directories = ["src", "tests", "scripts", "db", "docs", "scanner"];
const rootFiles = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "biome.json",
  "wrangler.jsonc",
  ".gitignore",
  ".ignore",
  ".gitattributes",
  "README.md",
  "AGENTS.md",
  "CONTRIBUTING.md",
  "DEVELOPMENT_PLAN.md",
];

/** 活动图白名单，永不递归扫描 old、缓存、环境文件或历史锁文件。 */
export async function sourceFiles() {
  const files = [...rootFiles];
  async function walk(directory) {
    for (const entry of await readdir(path.join(root, directory), { withFileTypes: true })) {
      const relative = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`SOURCE_LINK_NOT_ALLOWED: ${relative}`);
      if (entry.isDirectory()) await walk(relative);
      else if (entry.isFile()) files.push(relative);
    }
  }
  for (const directory of directories) await walk(directory);
  return files.sort();
}
