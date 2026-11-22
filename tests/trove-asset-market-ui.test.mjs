import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreRoute, storeRoute } from "../src/web/store-view.client.js";
import { click, content, sample, store } from "./store-client-fixture.mjs";
import { browserModules, dataModule } from "./web-client-fixture.mjs";

const session = { enabled: true, principal: "user:alice", csrf: "a".repeat(64) };

test("素材市场与求购广场 hash 路由解析和序列化保留细分参数", () => {
  assert.deepEqual(
    readStoreRoute(
      "#assets?mode=requests&category=images&style=pixel&format=png&license=commercial&space=loom&q=UI",
    ),
    {
      view: "assets",
      filters: {
        q: "UI",
        kind: "",
        mode: "requests",
        category: "images",
        style: "pixel",
        format: "PNG",
        license: "commercial",
        space: "loom",
      },
    },
  );
  assert.deepEqual(readStoreRoute("#assets?category=__proto__&license=unspecified"), {
    view: "assets",
    filters: { q: "", kind: "" },
  });
  const encoded = storeRoute("assets", {
    q: "像素",
    kind: "",
    mode: "requests",
    category: "images",
  });
  assert.equal(encoded, "#assets?q=%E5%83%8F%E7%B4%A0&mode=requests&category=images");
});

test("商店 #assets 素材细分筛选、求购广场浏览、发布求购、方案响应与关闭闭环", async (t) => {
  const taggedAsset = {
    ...sample("art"),
    id: "11111111-2222-4333-8444-555555555555",
    title: "Pixel Kit · 像素界面",
    assetAttributes: {
      category: "images",
      style: "pixel",
      formats: ["PNG", "ASEPRITE"],
      license: "commercial",
    },
  };
  let storedRequest = {
    id: "22222222-3333-4444-8555-666666666666",
    title: "求一套低多边形森林场景",
    category: "models",
    style: "lowpoly",
    space: "general",
    formats: ["GLB", "PNG"],
    license: "commercial",
    periodDays: 14,
    budgetNote: "开源共创",
    description: "树木、岩石与地表组件",
    delivery: "GLB 与组合预览",
    state: "open",
    revision: 1,
    responseCount: 0,
  };
  let viewerRole = "responder";
  const responses = [];

  const app = await store(
    t,
    async (path, options = {}) => {
      if (path === "/auth/session") return Response.json(session);
      if (path.startsWith("/v1/catalog/")) return Response.json(taggedAsset);
      if (path.startsWith("/v1/catalog?"))
        return Response.json({ items: [taggedAsset], nextAfter: null });
      if (path === "/v1/asset-requests" && options.method === "POST") {
        const body = JSON.parse(options.body);
        storedRequest = {
          ...storedRequest,
          ...body,
          state: "open",
          revision: 1,
          responseCount: 0,
        };
        viewerRole = "requester";
        return Response.json(storedRequest, { status: 201 });
      }
      if (path.startsWith("/v1/asset-requests?"))
        return Response.json({ items: [storedRequest], nextAfter: null });
      if (path === `/v1/asset-requests/${storedRequest.id}`) return Response.json(storedRequest);
      if (
        path.startsWith(`/v1/asset-requests/${storedRequest.id}/responses`) &&
        (options.method ?? "GET") === "GET"
      ) {
        return Response.json({
          viewerRole,
          request: storedRequest,
          items: responses,
          nextAfter: null,
        });
      }
      if (
        path === `/v1/asset-requests/${storedRequest.id}/responses` &&
        options.method === "POST"
      ) {
        const body = JSON.parse(options.body);
        const created = {
          id: "33333333-4444-4555-8666-777777777777",
          requestId: storedRequest.id,
          responder: "user:alice",
          publicationId: body.publicationId,
          publicationTitle: null,
          message: body.message,
          createdAt: Date.now(),
        };
        responses.push(created);
        storedRequest.responseCount += 1;
        return Response.json(created, { status: 201 });
      }
      if (path === `/v1/asset-requests/${storedRequest.id}/close` && options.method === "POST") {
        storedRequest = { ...storedRequest, state: "closed", revision: 2 };
        return Response.json(storedRequest);
      }
      throw new Error(`UNEXPECTED_FETCH: ${path}`);
    },
    { hash: "#assets" },
  );
  await app.ready;
  assert.equal(app.element("asset-hub").hidden, false);
  assert.equal(app.element("catalog").hidden, false);
  assert.match(content(app.element("results").children[0]), /2D 与 UI/);
  assert.match(content(app.element("results").children[0]), /像素/);

  // 细分分类筛选触发真实参数查询并生成可清除筛选标签
  await click(app.element("am-cat-images"));
  assert.match(app.requests.at(-1).path, /section=assets/);
  assert.match(app.requests.at(-1).path, /category=images/);
  assert.equal(app.element("am-chips").children.length, 1);

  // 切换到求购广场读取公开求购，作为非发起人提交方案
  await click(app.element("am-mode-requests"));
  assert.equal(app.element("catalog").hidden, true);
  assert.equal(app.element("requests-panel").hidden, false);
  assert.match(app.requests.at(-1).path, /^\/v1\/asset-requests\?/);
  const reqCard = app.element("requests-results").children[0];
  assert.match(content(reqCard), /求一套低多边形森林场景/);

  const openDetailBtn = reqCard.children.at(-1).children[1];
  await click(openDetailBtn);
  assert.equal(app.element("request-detail").open, true);
  assert.equal(app.element("req-response-form").hidden, false);
  assert.equal(app.element("req-close-action").hidden, true);

  app.element("req-response-message").value = "可提供模块化 GLB 森林组件";
  await app.element("req-response-form").listeners.get("submit")({ preventDefault() {} });
  assert.equal(responses.length, 1);
  assert.equal(app.element("req-response-form").hidden, true);

  // 发布新求购并以发起人身份关闭求购
  app.element("request-detail").close();
  click(app.element("request-open"));
  assert.equal(app.element("request-compose").open, true);
  app.element("req-title").value = "新像素图标求购";
  app.element("req-category").value = "images";
  app.element("req-style").value = "pixel";
  app.element("req-space").value = "general";
  app.element("req-formats").value = "PNG, SVG";
  app.element("req-license").value = "commercial";
  app.element("req-period").value = "7";
  app.element("req-budget").value = "共创";
  app.element("req-delivery").value = "PNG 与 SVG";
  app.element("req-description").value = "需要 32x32 道具图标";
  await app.element("request-form").listeners.get("submit")({ preventDefault() {} });
  assert.equal(app.element("request-compose").open, false);

  const createdCardBtn = app.element("requests-results").children[0].children.at(-1).children[1];
  await click(createdCardBtn);
  assert.equal(app.element("req-close-action").hidden, false);
  await click(app.element("req-close-action"));
  assert.equal(storedRequest.state, "closed");
});

test("访客在 #assets 点击发布求购弹出返回商店的登录提示", async (t) => {
  const app = await store(
    t,
    (path) =>
      Response.json(path === "/auth/session" ? { enabled: true } : { items: [], nextAfter: null }),
    { hash: "#assets" },
  );
  await app.ready;
  click(app.element("request-open"));
  assert.equal(app.element("publish-dialog").open, true);
  assert.equal(app.element("publish-title").textContent, "请先登录后发布求购");
  assert.equal(app.element("publish-login").attributes.get("action"), "/auth/login");
});

test("工作台素材细分属性表单保存与格式归一化", async () => {
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
  const render = dataModule(`
    export const element = id => globalThis.__attrUi.nodes[id];
    export const confirmAction = async () => true;
  `);
  globalThis.__attrUi = { nodes };
  globalThis.window = { location: { href: "https://assetlibrary.test/workspace" } };
  const source = (await readFile(new URL("../src/web/showcase.client.js", import.meta.url), "utf8"))
    .replace('from "./api.client.js"', `from ${JSON.stringify(modules.apiUrl)}`)
    .replace('from "./render.client.js"', `from ${JSON.stringify(render)}`);
  const { initShowcaseManagement } = await import(dataModule(source));
  const tasks = new Map();
  let ui;
  const refreshControls = () => ui?.controls(false, true);
  const capture = (id, task) =>
    tasks.set(id, (signal = new AbortController().signal) => task(signal));
  ui = initShowcaseManagement({
    form: capture,
    button: capture,
    refreshControls,
    async changed(_signal, updated) {
      ui.show(updated, "user:alice");
      refreshControls();
    },
  });
  modules.api.setCredential("test-credential");
  const resource = {
    id: crypto.randomUUID(),
    title: "测试素材",
    state: "draft",
    revision: 1,
    owner: "user:alice",
    profile: { space: "general", summary: "", detail: "", cover: null },
    assetAttributes: { category: "general", style: "general", formats: [], license: "unspecified" },
  };
  try {
    ui.show(resource, "user:alice");
    refreshControls();
    assert.equal(nodes["resource-attributes-save"].disabled, true);
    nodes["resource-asset-category"].value = "materials";
    nodes["resource-asset-style"].value = "realistic";
    nodes["resource-asset-formats"].value = "png, shader";
    nodes["resource-asset-license"].value = "commercial";
    refreshControls();
    assert.equal(nodes["resource-attributes-save"].disabled, false);

    let sent;
    globalThis.fetch = async (path, options) => {
      sent = { path, body: JSON.parse(options.body) };
      return Response.json({
        ...resource,
        revision: 2,
        assetAttributes: sent.body,
      });
    };
    await tasks.get("resource-attributes-form")();
    assert.equal(sent.path, `/v1/resources/${resource.id}/attributes`);
    assert.deepEqual(sent.body, {
      revision: 1,
      category: "materials",
      style: "realistic",
      formats: ["PNG", "SHADER"],
      license: "commercial",
    });
    assert.equal(nodes["resource-attributes-save"].disabled, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
    delete globalThis.__attrUi;
  }
});
