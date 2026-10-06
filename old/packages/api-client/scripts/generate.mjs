import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(packageRoot, "../..");
const outputRoot = resolve(packageRoot, "src/generated");
const domains = [
  "public",
  "consumer",
  "publisher-packages",
  "publisher-releases",
  "publisher-signing",
  "publisher-upload",
  "publisher-submissions",
  "publisher-moderation",
  "operator-review",
  "operator-moderation",
];
const check = process.argv.includes("--check");
const banner = "// Generated from contracts/openapi/domains. Do not edit manually.\n";
let stale = false;

await mkdir(outputRoot, { recursive: true });
for (const domain of domains) {
  const schema = pathToFileURL(resolve(repositoryRoot, `contracts/openapi/domains/${domain}.yaml`));
  const output = resolve(outputRoot, `${domain}.ts`);
  const generated = banner + astToString(await openapiTS(schema, {
    alphabetize: true,
    commentHeader: "",
  }));
  if (!check) {
    await writeFile(output, generated, "utf8");
    console.log(`generated ${domain}.ts`);
    continue;
  }
  const current = await readFile(output, "utf8").catch(() => "");
  if (current !== generated) {
    stale = true;
    console.error(`${domain}.ts is stale; run pnpm generate`);
  }
}
if (stale) process.exitCode = 1;
else if (check) console.log("Generated domain clients are current.");
