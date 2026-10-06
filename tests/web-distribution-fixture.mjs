import { readFile } from "node:fs/promises";
import { browserModules, dataModule } from "./web-client-fixture.mjs";

class Element {
  value = "";
  textContent = "";
  disabled = false;
  listeners = new Map();
  addEventListener(name, listener) {
    this.listeners.set(name, listener);
  }
  replaceChildren() {
    this.textContent = "";
  }
  querySelectorAll() {
    return this.children ?? [];
  }
  input(value) {
    this.value = value;
    this.listeners.get("input")?.();
  }
}

export async function distributionUi() {
  const modules = await browserModules();
  const nodes = new Proxy(
    {},
    {
      get(target, name) {
        target[name] ??= new Element();
        return target[name];
      },
    },
  );
  nodes["grant-read-form"].children = [nodes["grant-principal"]];
  globalThis.__distributionNodes = nodes;
  const render = dataModule(`
    export const element = id => globalThis.__distributionNodes[id];
    export const facts = (id, value) => element(id).textContent = JSON.stringify(value);
    export const notice = () => {};
    export const confirmAction = async () => true;
  `);
  const display = dataModule(`
    import { element, facts } from ${JSON.stringify(render)};
    export const distributionList = (name, rows) => facts(name, rows);
    export const management = (managed, grant) => { facts('publication-detail', managed); facts('grant-detail', grant); };
  `);
  const download = dataModule(
    "export const fetchPackage = async () => {}; export const savePackage = () => {};",
  );
  let source = await readFile(
    new URL("../src/web/distribution.client.js", import.meta.url),
    "utf8",
  );
  for (const [file, url] of [
    ["api", modules.apiUrl],
    ["render", render],
    ["distribution-render", display],
    ["download", download],
    [
      "resume-download",
      dataModule(
        `export const createDownloadTransfer = () => ({ snapshot: () => null, clear: () => {}, fetch: async () => ({blob: null, versionId: null}) });`,
      ),
    ],
  ])
    source = source.replace(`from "./${file}.client.js"`, `from ${JSON.stringify(url)}`);
  const { initDistribution } = await import(dataModule(source));
  const tasks = new Map();
  let ui;
  const control = new AbortController();
  const refreshControls = () => ui?.controls(false, modules.api.connected());
  const capture = (id, task) =>
    tasks.set(id, async (signal = control.signal) => {
      ui.controls(true, modules.api.connected());
      try {
        return await task(signal);
      } finally {
        refreshControls();
      }
    });
  ui = initDistribution({
    run: (task) => task(control.signal),
    button: capture,
    form: capture,
    refreshControls,
  });
  refreshControls();
  return { ...modules, ui, nodes, tasks, control, refreshControls };
}
