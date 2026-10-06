import { spawnSync } from "node:child_process";
import { readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "./build.mjs";
import { root } from "./source-scope.mjs";

const output = await build();
const tests = (await readdir(path.join(root, "tests"))).filter((file) =>
  file.endsWith(".test.mjs"),
);
const requested = process.argv.slice(2);
if (requested.some((file) => !tests.includes(file))) throw new Error("UNKNOWN_TEST_FILE");
const selected = requested.length ? requested : tests;
const result = spawnSync(
  process.execPath,
  ["--test", "--test-concurrency=1", ...selected.map((file) => `tests/${file}`)],
  {
    cwd: root,
    encoding: "utf8",
    timeout: 180000,
    env: { ...process.env, ASSETLIBRARY_BUNDLE: path.join(output, "index.js") },
  },
);
const log = `${result.stdout ?? ""}${result.stderr ?? ""}`;
console.log(log);
await writeFile(path.join(output, "tests.log"), log, "utf8");
if (result.error) console.error(result.error.message);
process.exitCode = result.error ? 1 : (result.status ?? 1);
