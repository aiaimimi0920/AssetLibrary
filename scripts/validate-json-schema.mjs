import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.dirname(scriptDirectory);
const requireFromWeb = createRequire(path.join(repositoryRoot, "apps", "web", "package.json"));
const ajvModule = requireFromWeb("ajv/dist/2020");
const formatsModule = requireFromWeb("ajv-formats");
const Ajv2020 = ajvModule.default || ajvModule;
const addFormats = formatsModule.default || formatsModule;
const maximumBytes = 16 * 1024 * 1024;

function fail(message) {
  process.stdout.write(`${message}\n`);
  process.exit(1);
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index + 1 >= process.argv.length) fail(`${name} is required.`);
  return process.argv[index + 1];
}

function readJson(filePath, label) {
  let stats;
  try {
    stats = fs.statSync(filePath);
  } catch {
    fail(`${label} does not exist.`);
  }
  if (!stats.isFile() || stats.size < 1 || stats.size > maximumBytes) {
    fail(`${label} must be a non-empty JSON file no larger than ${maximumBytes} bytes.`);
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    fail(`${label} is not valid UTF-8 JSON.`);
  }
}

const schemaPath = argument("--schema");
const documentIndex = process.argv.indexOf("--document");
const schema = readJson(schemaPath, "Schema");
const ajv = new Ajv2020({ allErrors: true, strict: true, validateFormats: true });
addFormats(ajv);

let validate;
try {
  validate = ajv.compile(schema);
} catch (error) {
  fail(`Schema compilation failed: ${error instanceof Error ? error.message : "unknown error"}`);
}
if (documentIndex < 0) process.exit(0);
if (documentIndex + 1 >= process.argv.length) fail("--document requires a path.");

const document = readJson(process.argv[documentIndex + 1], "Document");
if (!validate(document)) {
  const errors = (validate.errors || []).slice(0, 20).map((error) => {
    const location = error.instancePath || "/";
    return `${location}: ${error.keyword} ${error.message || "validation failed"}`;
  });
  fail(`JSON Schema validation failed (${errors.join("; ")}).`);
}
