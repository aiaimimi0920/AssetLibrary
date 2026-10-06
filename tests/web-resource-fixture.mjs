import { readFile } from "node:fs/promises";
import { browserModules, dataModule } from "./web-client-fixture.mjs";

export async function resourceUi() {
  const modules = await browserModules();
  const nodes = new Proxy(
    {},
    {
      get(target, id) {
        target[id] ??= {
          value: "",
          textContent: "",
          disabled: false,
          listeners: {},
          children: [],
          addEventListener(name, listener) {
            this.listeners[name] = listener;
          },
          querySelectorAll() {
            return this.children;
          },
          input(value) {
            this.value = value;
            this.listeners.input?.();
          },
        };
        return target[id];
      },
    },
  );
  nodes["resource-edit-form"].children = [nodes["resource-title"], nodes["resource-save"]];
  nodes["member-read-form"].children = [nodes["member-principal"], nodes["member-read-button"]];
  const state = { nodes, confirmation: true, confirmations: [], changes: [] };
  globalThis.__resourceUi = state;
  const render = dataModule(`
    export const element = id => globalThis.__resourceUi.nodes[id];
    export const facts = (id, value) => element(id).textContent = JSON.stringify(value);
    export const confirmAction = async (...args) => {
      globalThis.__resourceUi.confirmations.push(args);
      return globalThis.__resourceUi.confirmation;
    };
  `);
  const source = (await readFile(new URL("../src/web/resource.client.js", import.meta.url), "utf8"))
    .replace('from "./api.client.js"', `from ${JSON.stringify(modules.apiUrl)}`)
    .replace('from "./render.client.js"', `from ${JSON.stringify(render)}`);
  const { initResourceManagement } = await import(dataModule(source));
  let ui;
  const tasks = new Map();
  const refreshControls = () => ui?.controls(false, modules.api.connected());
  const capture = (id, task) =>
    tasks.set(id, async (signal = new AbortController().signal) => {
      ui.controls(true, modules.api.connected());
      try {
        return await task(signal);
      } finally {
        refreshControls();
      }
    });
  ui = initResourceManagement({
    form: capture,
    button: capture,
    refreshControls,
    async changed(_signal, resource) {
      state.changes.push(resource);
      ui.show(resource.state === "deleted" ? null : resource, "user:alice");
    },
  });
  modules.api.setCredential("test-credential");
  const resource = {
    id: crypto.randomUUID(),
    title: "原始标题",
    state: "draft",
    revision: 3,
    owner: "user:alice",
  };
  ui.show(resource, "user:alice");
  refreshControls();
  return { ...modules, state, resource, ui, nodes, tasks, refreshControls };
}
