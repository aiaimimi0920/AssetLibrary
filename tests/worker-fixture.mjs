import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function textModules(bundle) {
  const root = path.dirname(bundle);
  const manifest = JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
  const modules = {};
  for (const [name, type] of Object.entries(manifest.modules ?? {})) {
    if (type !== "text" || !/^[0-9a-f]{40}-[A-Za-z.-]+$/.test(name))
      throw new Error("INVALID_TEXT_MODULE");
    const bytes = await readFile(path.join(root, name));
    if (createHash("sha256").update(bytes).digest("hex") !== manifest.artifacts[name])
      throw new Error("TEXT_MODULE_HASH_MISMATCH");
    modules[name] = {
      type: "text",
      contents: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    };
  }
  if (Object.keys(modules).length !== 10) throw new Error("WEB_MODULE_COVERAGE_INCOMPLETE");
  return modules;
}

let loaded;
/** Node 没有 workerd 的 Text loader。只展开已核验的静态文本导入，不改业务语句或准入逻辑。 */
export async function hostWorker() {
  if (!loaded)
    loaded = (async () => {
      const bundle = process.env.ASSETLIBRARY_BUNDLE;
      const modules = await textModules(bundle);
      let source = await readFile(bundle, "utf8");
      for (const [name, module] of Object.entries(modules)) {
        const expression = new RegExp(
          `^import ([A-Za-z_$][\\w$]*) from "\\./${name.replaceAll(".", "\\.")}";$`,
          "m",
        );
        if (!expression.test(source)) throw new Error("TEXT_MODULE_IMPORT_MISSING");
        source = source.replace(
          expression,
          (_match, binding) => `const ${binding} = ${JSON.stringify(module.contents)};`,
        );
      }
      return (await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`))
        .default;
    })();
  return loaded;
}
