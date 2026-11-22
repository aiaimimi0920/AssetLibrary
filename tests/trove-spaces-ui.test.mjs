import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreRoute, storeRoute } from "../src/web/store-view.client.js";
import { click, content, sample, store } from "./store-client-fixture.mjs";
import { browserModules, dataModule } from "./web-client-fixture.mjs";

const session = { enabled: true, principal: "owner", csrf: "a".repeat(64) };

test("内容空间路由解析与序列化保留合法空间和类型，未知空间回退首页", () => {
  assert.deepEqual(readStoreRoute("#app/loom?kind=mcp&q=%20Color%20"), {
    view: "app:loom",
    filters: { q: "Color", kind: "mcp" },
  });
  assert.equal(readStoreRoute("#app/__proto__").view, "home");
  assert.equal(readStoreRoute("#app/unknown").view, "home");
  assert.equal(readStoreRoute("#app:loom").view, "home");
  assert.equal(
    storeRoute("app:loom", { q: "节点", kind: "art" }),
    "#app/loom?q=%E8%8A%82%E7%82%B9&kind=art",
  );
});

test("商店内容空间横幅、真实封面图、详情简介及空间双向跳转正常工作", async (t) => {
  const loomApp = {
    ...sample("application"),
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    title: "Loom 桌面端",
    space: "loom",
    summary: "把想法连接成作品的工作台",
    detail: "聚合 Art 节点与 MCP 扩展。",
    cover: {
      url: "/v1/catalog/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/cover",
      sha256: "d".repeat(64),
      size: 512,
      width: 640,
      height: 360,
    },
  };
  const plainMcp = {
    ...sample("mcp"),
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    title: "无封面 MCP",
    space: "general",
    summary: "",
    detail: "",
    cover: null,
  };
  const app = await store(t, (path) => {
    if (path === "/auth/session") return Response.json(session);
    if (path === `/v1/catalog/${loomApp.id}`) return Response.json(loomApp);
    if (path.includes("space=loom")) return Response.json({ items: [loomApp], nextAfter: null });
    return Response.json({ items: [loomApp, plainMcp], nextAfter: null });
  });
  await app.ready;

  // 初始首页仅发一次 session 与一次匿名目录读取，不因内容空间卡片追加请求。
  assert.deepEqual(
    app.requests.map(({ path }) => path),
    ["/auth/session", "/v1/catalog?limit=20"],
  );
  const cards = app.element("results").children;
  assert.equal(cards.length, 2);
  const coverNode = cards[0].children[0];
  assert.equal(coverNode.children[0].tagName, "IMG");
  assert.equal(
    coverNode.children[0].attributes.get("src"),
    `${loomApp.cover.url}?v=${loomApp.cover.sha256.slice(0, 16)}`,
  );
  assert.equal(coverNode.children[0].attributes.get("decoding"), "async");
  assert.match(content(cards[0]), /Loom 空间/);
  assert.match(content(cards[0]), /把想法连接成作品的工作台/);
  assert.equal(cards[1].children[0].children[1].textContent, "MCP");

  // 打开详情展示封面、简介、详细介绍及进入空间入口，点击跳转到 #app/loom。
  const openButton = cards[0].children[1].children.at(-1).children[1];
  await click(openButton);
  assert.equal(app.element("detail").open, true);
  assert.equal(app.element("detail-summary").hidden, false);
  assert.equal(app.element("detail-summary").textContent, loomApp.summary);
  assert.equal(app.element("detail-description").hidden, false);
  assert.equal(app.element("detail-description").textContent, loomApp.detail);
  assert.equal(app.element("detail-space").hidden, false);
  assert.match(app.element("detail-cover-note").textContent, /640×360/);

  app.element("detail-space").listeners.get("click")({ preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.element("detail").open, false);
  assert.equal(app.element("space").hidden, false);
  assert.equal(app.element("space-title").textContent, "Loom 内容空间");
  assert.equal(globalThis.window.location.hash, "#app/loom");
  assert.match(app.requests.at(-1).path, /space=loom/);

  // 已登录点击“为它发布内容 ＋”跳转到带 space 参数的工作台。
  click(app.element("space-publish"));
  assert.deepEqual(app.redirects, ["/workspace?space=loom"]);
});

test("访客在内容空间点击发布弹出登录提示，关闭后焦点回到空间发布按钮", async (t) => {
  const app = await store(
    t,
    (path) =>
      Response.json(path === "/auth/session" ? { enabled: true } : { items: [], nextAfter: null }),
    { hash: "#app/otter" },
  );
  await app.ready;
  assert.equal(app.element("space").hidden, false);
  assert.equal(app.element("space-title").textContent, "Otter 内容空间");
  click(app.element("space-publish"));
  assert.equal(app.element("publish-dialog").open, true);
  click(app.element("publish-close"));
  assert.equal(globalThis.document.activeElement, app.element("space-publish"));
});

test("工作台展示资料与封面模块：URL 预选空间、确认门禁、幂等重试与非 owner 禁用", async () => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  const modules = await browserModules();
  const nodes = new Proxy(
    {},
    {
      get(target, id) {
        target[id] ??= {
          value: "",
          textContent: "",
          disabled: false,
          files: [],
          listeners: {},
          children: [],
          addEventListener(name, listener) {
            this.listeners[name] = listener;
          },
          querySelectorAll() {
            return this.children;
          },
        };
        return target[id];
      },
    },
  );
  nodes["resource-profile-form"].children = [
    nodes["resource-space"],
    nodes["resource-summary"],
    nodes["resource-detail-text"],
    nodes["resource-profile-save"],
  ];
  nodes["resource-cover-form"].children = [
    nodes["resource-cover-file"],
    nodes["resource-cover-save"],
    nodes["resource-cover-clear"],
  ];
  const state = { confirmation: true, confirmations: [], changes: [] };
  globalThis.__showcaseUi = { nodes, state };
  globalThis.window = { location: { href: "https://assetlibrary.test/workspace?space=loom" } };
  const render = dataModule(`
    export const element = id => globalThis.__showcaseUi.nodes[id];
    export const confirmAction = async (...args) => {
      globalThis.__showcaseUi.state.confirmations.push(args);
      return globalThis.__showcaseUi.state.confirmation;
    };
  `);
  const source = (await readFile(new URL("../src/web/showcase.client.js", import.meta.url), "utf8"))
    .replace('from "./api.client.js"', `from ${JSON.stringify(modules.apiUrl)}`)
    .replace('from "./render.client.js"', `from ${JSON.stringify(render)}`);
  const { initShowcaseManagement } = await import(dataModule(source));
  const tasks = new Map();
  let ui;
  const refreshControls = () => ui?.controls(false, modules.api.connected());
  const capture = (id, task) =>
    tasks.set(id, (signal = new AbortController().signal) => task(signal));
  ui = initShowcaseManagement({
    form: capture,
    button: capture,
    refreshControls,
    async changed(_signal, resource) {
      state.changes.push(resource);
      ui.show(resource, "user:alice");
      refreshControls();
    },
  });
  modules.api.setCredential("test-credential");
  const resource = {
    id: crypto.randomUUID(),
    title: "新作品",
    state: "draft",
    revision: 1,
    owner: "user:alice",
    profile: { space: "general", summary: "", detail: "", cover: null },
  };
  try {
    ui.show(resource, "user:alice");
    refreshControls();
    assert.equal(nodes["resource-space"].value, "loom", "URL ?space=loom 预填新建资源空间");
    assert.equal(nodes["resource-profile-save"].disabled, false);
    assert.equal(nodes["resource-cover-clear"].disabled, true);

    const keys = [];
    globalThis.fetch = async (path, options) => {
      keys.push({ path, key: options.headers["Idempotency-Key"], body: options.body });
      if (keys.length === 1) throw new TypeError("network down");
      return Response.json({
        ...resource,
        revision: 2,
        profile: {
          space: "loom",
          summary: "一句话说明",
          detail: "详细说明",
          cover: {
            sha256: "e".repeat(64),
            size: 120,
            width: 32,
            height: 18,
            url: `/v1/resources/${resource.id}/cover`,
          },
        },
      });
    };
    nodes["resource-summary"].value = "  一句话说明 ";
    nodes["resource-detail-text"].value = "详细说明\r\n";
    await assert.rejects(tasks.get("resource-profile-form")(), /network down/);
    await tasks.get("resource-profile-form")();
    assert.equal(keys[0].key, keys[1].key, "网络中断重提保持同一幂等键");
    assert.deepEqual(JSON.parse(keys[1].body), {
      revision: 1,
      space: "loom",
      summary: "一句话说明",
      detail: "详细说明",
    });
    assert.equal(nodes["resource-cover-clear"].disabled, false);

    // 非 owner 只读成员全部禁用
    ui.show(state.changes[0], "user:bob");
    refreshControls();
    assert.equal(nodes["resource-profile-save"].disabled, true);
    assert.equal(nodes["resource-cover-clear"].disabled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    delete globalThis.__showcaseUi;
  }
});
