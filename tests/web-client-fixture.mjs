import { readFile } from "node:fs/promises";

export const dataModule = (source) =>
  `data:text/javascript;base64,${Buffer.from(`${source}\n// ${crypto.randomUUID()}`).toString("base64")}`;

export async function browserModules() {
  const apiSource = await readFile(new URL("../src/web/api.client.js", import.meta.url), "utf8");
  const apiUrl = dataModule(apiSource);
  let downloadUrl;
  async function load(name) {
    const source = await readFile(new URL(`../src/web/${name}.client.js`, import.meta.url), "utf8");
    const url = dataModule(
      source
        .replace('from "./api.client.js"', `from ${JSON.stringify(apiUrl)}`)
        .replace('from "./download.client.js"', `from ${JSON.stringify(downloadUrl)}`),
    );
    if (name === "download") downloadUrl = url;
    return import(url);
  }
  return {
    api: await import(apiUrl),
    apiUrl,
    download: await load("download"),
    upload: await load("upload"),
    resume: await load("resume-download"),
  };
}
