import { readFile } from "node:fs/promises";

export const dataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(`${source}\n// ${crypto.randomUUID()}`).toString("base64")}`;

export async function browserModules() {
  const apiSource = await readFile(new URL("../src/web/api.client.js", import.meta.url), "utf8");
  const apiUrl = dataModule(apiSource);
  async function load(name) {
    const source = await readFile(new URL(`../src/web/${name}.client.js`, import.meta.url), "utf8");
    return import(
      dataModule(source.replace('from "./api.client.js"', `from ${JSON.stringify(apiUrl)}`))
    );
  }
  return {
    api: await import(apiUrl),
    apiUrl,
    download: await load("download"),
    upload: await load("upload"),
  };
}
