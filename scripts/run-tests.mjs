import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { build } from "./build.mjs";
import { root } from "./source-scope.mjs";
import { runTestProcess } from "./test-process.mjs";

const output = await build();
const tests = (await readdir(path.join(root, "tests"))).filter((file) =>
  file.endsWith(".test.mjs"),
);
const requested = process.argv.slice(2);
if (requested.some((file) => !tests.includes(file))) throw new Error("UNKNOWN_TEST_FILE");
const selected = requested.length ? requested : tests;
const logPath = path.join(output, "tests.log");
const result = runTestProcess(
  ["--test", "--test-concurrency=1", ...selected.map((file) => `tests/${file}`)],
  {
    cwd: root,
    logPath,
    timeout: 600000,
    env: { ...process.env, ASSETLIBRARY_BUNDLE: path.join(output, "index.js") },
  },
);
await pipeline(createReadStream(logPath), process.stdout, { end: false });
if (result.error) console.error(result.error.message);
if (result.signal) console.error(`Test process signal: ${result.signal}`);
process.exitCode = result.exitCode;
