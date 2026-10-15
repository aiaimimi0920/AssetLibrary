import { readFile } from "node:fs/promises";

// 执行真实客户端模块；仅模拟 DOM 和 HTTP，不替换清理或事件处理逻辑。
export async function appFixture(t, respond) {
  const originals = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const nodes = new Map();
  function node() {
    return {
      value: "",
      textContent: "",
      dataset: {},
      hidden: false,
      disabled: false,
      children: [],
      listeners: new Map(),
      append(...children) {
        this.children.push(...children);
      },
      replaceChildren(...children) {
        this.children = children;
      },
      setAttribute() {},
      addEventListener(name, listener) {
        this.listeners.set(name, listener);
      },
      querySelector() {
        this.control ??= node();
        return this.control;
      },
      querySelectorAll() {
        return [this.querySelector()];
      },
      close() {
        this.open = false;
      },
    };
  }
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  globalThis.document = {
    getElementById: element,
    createElement: node,
    activeElement: null,
    querySelectorAll: (selector) =>
      selector === "[data-protected]" ? [element("refresh-resources")] : [],
  };
  globalThis.window = {
    location: {
      href: "https://assetlibrary.test/",
      assign() {
        throw new Error("UNEXPECTED_REDIRECT");
      },
    },
  };
  const requests = [];
  globalThis.fetch = async (path, options) => {
    requests.push({ path, options });
    return respond(path, options);
  };
  let api;
  t.after(() => {
    api?.stopRequests();
    for (const [key, value] of Object.entries(originals)) {
      if (value === undefined) delete globalThis[key];
      else globalThis[key] = value;
    }
  });
  const urls = new Map();
  const nonce = crypto.randomUUID();
  async function moduleUrl(name) {
    if (urls.has(name)) return urls.get(name);
    let source = await readFile(new URL(`../src/web/${name}`, import.meta.url), "utf8");
    for (const match of [...source.matchAll(/from "\.\/(.*?)"/g)])
      source = source.replace(match[0], `from "${await moduleUrl(match[1])}"`);
    const url = `data:text/javascript;base64,${Buffer.from(`${source}\n// ${nonce}\n//# sourceURL=assetlibrary-test/${name}`).toString("base64")}`;
    urls.set(name, url);
    return url;
  }
  await import(await moduleUrl("app.client.js"));
  api = await import(urls.get("api.client.js"));
  async function settled() {
    for (let count = 0; count < 100; count++) {
      await new Promise((resolve) => setImmediate(resolve));
      if (!element("identity-form").querySelector().disabled) return;
    }
    throw new Error("APP_DID_NOT_SETTLE");
  }
  await settled();
  return {
    element,
    api,
    requests,
    settled,
    async click(id) {
      element(id).listeners.get("click")();
      await settled();
    },
  };
}
