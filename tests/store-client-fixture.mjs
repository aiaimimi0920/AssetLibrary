import { readFile } from "node:fs/promises";

export async function store(t, respond, { hash = "" } = {}) {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const redirects = [];
  const nodes = new Map(),
    listeners = new Map(),
    requests = [],
    urls = new Map(),
    created = [];
  const node = (tag = "div") => {
    const value = {
      tagName: tag.toUpperCase(),
      textContent: "",
      value: "",
      attributes: new Map(),
      open: false,
      isConnected: true,
      hidden: false,
      disabled: false,
      dataset: {},
      children: [],
      listeners: new Map(),
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      focus() {
        globalThis.document.activeElement = this;
      },
      showModal() {
        this.open = true;
      },
      close() {
        if (this.open) {
          this.open = false;
          this.listeners.get("close")?.();
        }
      },
      scrollIntoView() {},
      addEventListener(event, callback) {
        this.listeners.set(event, callback);
      },
    };
    created.push(value);
    return value;
  };
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  globalThis.document = {
    getElementById: element,
    createElement: node,
    querySelectorAll: () => created,
  };
  globalThis.window = {
    location: { href: "https://assetlibrary.test/", hash, assign: (url) => redirects.push(url) },
    history: {
      pushState(_state, _title, hash) {
        globalThis.window.location.hash = hash;
      },
      replaceState(_state, _title, hash) {
        globalThis.window.location.hash = hash;
      },
    },
    addEventListener: (event, callback) => listeners.set(event, callback),
  };
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return respond(path, options);
  };
  const nonce = crypto.randomUUID();
  async function moduleUrl(name) {
    if (urls.has(name)) return urls.get(name);
    let source = await readFile(new URL(`../src/web/${name}`, import.meta.url), "utf8");
    for (const match of [...source.matchAll(/from "\.\/(.*?)"/g)])
      source = source.replace(match[0], `from "${await moduleUrl(match[1])}"`);
    const url = `data:text/javascript;base64,${Buffer.from(`${source}\n// ${nonce}`).toString("base64")}`;
    urls.set(name, url);
    return url;
  }
  const module = await import(await moduleUrl("store.client.js"));
  const api = await import(urls.get("api.client.js"));
  t.after(() => {
    api.stopRequests();
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  return {
    ready: module.ready,
    redirects,
    navigate(hash) {
      globalThis.window.location.hash = hash;
      return listeners.get("hashchange")();
    },
    api,
    requests,
    element: (id) => element(`store-${id}`),
    leave: () => listeners.get("pagehide")(),
  };
}

export const sample = (kind = "art") => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "真实名称 <img src=x onerror=alert(1)>",
  kind,
  label: "1.0.0",
  size: 798,
  sha256: "b".repeat(64),
  scanStatus: "not_scanned",
});
export const content = (node) => [node.textContent, ...node.children.map(content)].join(" ");
export const click = (node) => node.listeners.get("click")();
