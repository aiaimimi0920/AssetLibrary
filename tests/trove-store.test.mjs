import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readStoreRoute, storeRoute } from "../src/web/store-view.client.js";
import { click, sample, store } from "./store-client-fixture.mjs";

const session = { enabled: true, principal: "owner", csrf: "a".repeat(64) };
const respond =
  (identity = session) =>
  (path) =>
    Response.json(path === "/auth/session" ? identity : { items: [sample()], nextAfter: null });
const query = (app) => new URL(app.requests.at(-1).path, "https://example.test").searchParams;
const search = (app) => app.element("search").listeners.get("submit")({ preventDefault() {} });

test("Trove 品牌、五类顺序和发布登录使用固定同源入口", async () => {
  const html = await readFile(new URL("../src/web/store.html", import.meta.url), "utf8");
  assert.match(html, /src="\/beaver.svg"/);
  assert.match(html, /好东西，都在这！/);
  assert.match(html, /All the good stuff\. Right here!/);
  assert.deepEqual(
    [...html.matchAll(/id="store-section-([a-z]+)"/g)].map((m) => m[1]),
    ["games", "apps", "loom", "assets", "community"],
  );
  assert.match(html, /action="\/auth\/login\?returnTo=workspace" method="post"/);
  assert.doesNotMatch(html, /href="\/workspace"[^>]*>发布/);
});

test("hash 路由保留字面查询，丢弃未知分类与不适用包类型", () => {
  assert.deepEqual(readStoreRoute("#loom?kind=application&q=%20Color%25_%20"), {
    view: "loom",
    filters: { q: "Color%_", kind: "" },
  });
  assert.equal(readStoreRoute("#__proto__").view, "home");
  const filters = { q: "a?b & 中文", kind: "mcp" };
  assert.deepEqual(readStoreRoute(storeRoute("loom", filters)), { view: "loom", filters });
  assert.equal(readStoreRoute(`#assets?q=${"a".repeat(101)}`).filters.q.length, 100);
});

test("三个真实分区附固定过滤，不把游戏和社区当成假目录", async (t) => {
  const app = await store(t, respond());
  await app.ready;
  for (const [view, section, visible] of [
    ["apps", "applications", ["application"]],
    ["loom", "loom", ["art", "capability", "mcp"]],
    ["assets", "assets", ["art"]],
  ]) {
    await click(app.element(`section-${view}`));
    assert.equal(query(app).get("section"), section);
    assert.equal(app.element("catalog").hidden, false);
    for (const kind of ["art", "capability", "mcp", "application"])
      assert.equal(app.element(`category-${kind}`).hidden, !visible.includes(kind));
  }
  const count = app.requests.length;
  for (const view of ["games", "community"]) {
    await click(app.element(`section-${view}`));
    assert.equal(app.requests.length, count);
    assert.equal(app.element("catalog").hidden, true);
    assert.equal(app.element("unavailable").hidden, false);
    assert.match(app.element("unavailable-hint").textContent, /尚未开放/);
    assert.equal(app.element("results").children.length, 0);
  }
  app.element("query").value = "  真实作品  ";
  await search(app);
  assert.equal(query(app).get("q"), "真实作品");
  assert.equal(query(app).has("section"), false);
  assert.equal(app.element("public").attributes.get("aria-pressed"), "true");
});

test("分区保留各自搜索和类型，刷新链接恢复同一过滤", async (t) => {
  const app = await store(t, respond(), { hash: "#loom?kind=mcp&q=工具" });
  await app.ready;
  assert.equal(query(app).get("section"), "loom");
  assert.equal(query(app).get("kind"), "mcp");
  assert.equal(app.element("query").value, "工具");
  await click(app.element("section-assets"));
  app.element("query").value = "图像";
  await search(app);
  await click(app.element("section-loom"));
  assert.equal(query(app).get("q"), "工具");
  assert.equal(query(app).get("kind"), "mcp");
  await app.navigate("#assets?q=纹理");
  assert.equal(query(app).get("q"), "纹理");
  assert.equal(app.element("query").value, "纹理");
  const count = app.requests.length;
  await app.navigate("#store-main");
  assert.equal(app.requests.length, count, "跳过导航不能发起目录查询");
});

for (const loggedIn of [false, true]) {
  test(`初始资源库等身份读取后再访问：${loggedIn ? "已登录" : "访客"}`, async (t) => {
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const app = await store(
      t,
      async (path) => {
        if (path === "/auth/session") {
          await held;
          return Response.json(loggedIn ? session : { enabled: true });
        }
        return Response.json({ items: [], nextAfter: null });
      },
      { hash: "#library?kind=mcp&q=工具" },
    );
    assert.equal(app.requests.length, 1);
    assert.equal(app.element("publish").disabled, true);
    release();
    await app.ready;
    assert.equal(app.requests.length, 2);
    assert.ok(app.requests[1].path.startsWith(loggedIn ? "/v1/me/library?" : "/v1/catalog?"));
    assert.equal(app.api.connected(), loggedIn);
    if (loggedIn) assert.equal(query(app).get("q"), "工具");
    else assert.match(app.element("status").textContent, /请先登录/);
  });
}

test("发布入口：访客先登录，已登录才进工作台，未配置认证不提供假登录", async (t) => {
  const guest = await store(t, respond({ enabled: true }));
  await guest.ready;
  click(guest.element("publish"));
  assert.equal(guest.element("publish-dialog").open, true);
  assert.equal(guest.element("publish-login").hidden, false);
  assert.deepEqual(guest.redirects, []);
  click(guest.element("publish-close"));
  assert.equal(globalThis.document.activeElement, guest.element("publish"));
});

test("已登录发布跳转真实工作台", async (t) => {
  const app = await store(t, respond());
  await app.ready;
  click(app.element("publish"));
  assert.deepEqual(app.redirects, ["/workspace"]);
  assert.equal(app.element("publish-dialog").open, false);
});

test("账号未配置时不渲染发布登录表单", async (t) => {
  const app = await store(t, respond({ enabled: false }));
  await app.ready;
  click(app.element("publish"));
  assert.equal(app.element("publish-dialog").open, true);
  assert.equal(app.element("publish-login").hidden, true);
  assert.match(app.element("publish-hint").textContent, /账号服务暂不可用/);
  assert.deepEqual(app.redirects, []);
});

test("资源库等待 session 时仍可停止，迟到身份和排队路由不恢复", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = await store(
    t,
    async (path) => {
      await held;
      return respond()(path);
    },
    { hash: "#library" },
  );
  assert.equal(app.element("stop").disabled, false);
  app.navigate("#loom");
  click(app.element("stop"));
  release();
  await app.ready;
  assert.equal(app.api.connected(), false);
  assert.equal(app.requests.length, 1);
  assert.equal(globalThis.window.location.hash, "#home");
});

test("初始化期间的最新 hash 不被迟到 session 覆盖或重发身份读取", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = await store(t, async (path) => {
    if (path === "/v1/catalog?limit=20") await held;
    return respond()(path);
  });
  app.navigate("#apps");
  app.navigate("#loom?kind=mcp&q=latest");
  release();
  await app.ready;
  assert.equal(app.api.connected(), true);
  assert.equal(query(app).get("section"), "loom");
  assert.equal(query(app).get("q"), "latest");
  assert.equal(app.requests.filter(({ path }) => path === "/auth/session").length, 1);
  assert.equal(app.requests.length, 3);
});

test("切换中只读取最后一个路由，取消的旧响应不进入新页", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = await store(t, async (path) => {
    if (path.includes("section=applications")) await held;
    return respond()(path);
  });
  await app.ready;
  const task = click(app.element("section-apps"));
  app.navigate("#loom");
  app.navigate("#assets?q=latest");
  release();
  await task;
  assert.equal(query(app).get("section"), "assets");
  assert.equal(query(app).get("q"), "latest");
  assert.equal(
    app.requests.some(({ path }) => path.includes("section=loom")),
    false,
  );
  assert.equal(app.element("section-assets").attributes.get("aria-pressed"), "true");
});

test("停止初始化同时放弃排队路由，后到响应不能恢复任务", async (t) => {
  let release;
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = await store(t, async (path) => {
    if (path !== "/auth/session") await held;
    return respond()(path);
  });
  app.navigate("#loom");
  click(app.element("stop"));
  release();
  await app.ready;
  assert.equal(app.api.connected(), false);
  assert.equal(app.requests.length, 2);
});

test("退出后立即清空私库和过滤，跳转失败也不保留旧主体视图", async (t) => {
  const app = await store(t, (path) =>
    path === "/auth/logout"
      ? Response.json({ logoutUrl: "https://account.example/oauth2/v1/logout" })
      : respond()(path),
  );
  await app.ready;
  await app.navigate("#library?q=private&kind=art");
  await click(app.element("logout"));
  assert.equal(app.api.connected(), false);
  assert.equal(app.element("results").children.length, 0);
  assert.equal(app.element("query").value, "");
  assert.equal(app.element("library").disabled, true);
  assert.equal(app.element("public").attributes.get("aria-pressed"), "true");
  assert.deepEqual(app.redirects, ["https://account.example/oauth2/v1/logout"]);
});
