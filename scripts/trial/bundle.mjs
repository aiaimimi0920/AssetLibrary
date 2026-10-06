import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

const gate = `function requireDeploymentAdmission() {
  throw new HttpError(409, cloudScanBlocker);
}`;
export function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error("TRIAL_SOURCE_CONTRACT_CHANGED");
  return source.replace(before, () => after);
}

/** 仅在 Node 本地体验器内存中假设部署准入；绝不写回源码或可部署候选。 */
export async function trialModules(directory) {
  const manifest = JSON.parse(await readFile(path.join(directory, "manifest.json"), "utf8"));
  const files = new Map();
  for (const [name, digest] of Object.entries(manifest.artifacts)) {
    if (name.includes("..") || path.isAbsolute(name)) throw new Error("INVALID_TRIAL_ARTIFACT");
    const bytes = await readFile(path.join(directory, name));
    if (createHash("sha256").update(bytes).digest("hex") !== digest)
      throw new Error("TRIAL_ARTIFACT_HASH_MISMATCH");
    files.set(name, bytes);
  }
  const original = files.get("index.js")?.toString("utf8");
  if (!original) throw new Error("TRIAL_BUNDLE_MISSING");
  const modules = {
    "index.js": {
      type: "esm",
      contents: replaceOnce(
        original,
        gate,
        "function requireDeploymentAdmission() { /* LOCAL TRIAL ONLY */ }",
      ),
    },
  };
  for (const [name, type] of Object.entries(manifest.modules)) {
    if (type !== "text" || !files.has(name)) throw new Error("INVALID_TRIAL_MODULE");
    modules[name] = { type, contents: files.get(name).toString("utf8") };
  }
  return { modules, manifest, sourceHash: manifest.artifacts["index.js"] };
}
