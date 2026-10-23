import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function store(t, respond) {
  const original = {
    document: globalThis.document,
    window: globalThis.window,
    fetch: globalThis.fetch,
  };
  const nodes = new Map(),
    listeners = new Map(),
    requests = [],
    urls = new Map();
  const node = () => ({
    textContent: "",
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
    setAttribute() {},
    focus() {},
    scrollIntoView() {},
    addEventListener(event, callback) {
      this.listeners.set(event, callback);
    },
  });
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, node());
    return nodes.get(id);
  };
  globalThis.document = {
    getElementById: element,
    createElement: node,
    querySelectorAll: () => [...nodes.values()],
  };
  globalThis.window = {
    location: { href: "https://assetlibrary.test/" },
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
    api,
    requests,
    element: (id) => element(`store-${id}`),
    leave: () => listeners.get("pagehide")(),
  };
}

for (const action of ["pagehide", "stop"]) {
  test(`商店 ${action} 后不应用已获取但尚未提交的 session`, async (t) => {
    let release;
    const app = await store(t, (path) =>
      path === "/auth/session"
        ? Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) })
        : new Promise((resolve) => {
            release = resolve;
          }),
    );
    if (action === "pagehide") app.leave();
    else app.element("stop").listeners.get("click")();
    release(Response.json({ items: [], nextAfter: null }));
    await app.ready;
    assert.equal(app.api.connected(), false);
    assert.doesNotMatch(app.element("session").textContent, /已登录/);
    assert.equal(app.requests.length, 2);
  });
}

test("商店仅一次 session 和匿名目录读取，无隐式私库或轮询", async (t) => {
  const app = await store(t, (path) =>
    Response.json(
      path === "/auth/session"
        ? { enabled: true, principal: null }
        : { items: [], nextAfter: null },
    ),
  );
  await app.ready;
  assert.equal(app.element("session").textContent, "访客浏览");
  assert.equal(app.element("library").disabled, true);
  assert.deepEqual(
    app.requests.map(({ path }) => path),
    ["/auth/session", "/v1/catalog?limit=20"],
  );
  assert.equal(app.requests[1].options.credentials, "omit");
});
