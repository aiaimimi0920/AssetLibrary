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

const sample = (kind = "art") => ({
  id: "11111111-1111-4111-8111-111111111111",
  title: "真实名称 <img src=x onerror=alert(1)>",
  kind,
  label: "1.0.0",
  size: 798,
  sha256: "b".repeat(64),
  scanStatus: "not_scanned",
});
const content = (node) => [node.textContent, ...node.children.map(content)].join(" ");
const click = (node) => node.listeners.get("click")();

test("四类卡片使用真实文本与明确类型占位，不伪造图片或评分", async (t) => {
  const items = ["art", "capability", "mcp", "application"].map(sample);
  const app = await store(t, (path) =>
    Response.json(path === "/auth/session" ? { enabled: true } : { items, nextAfter: null }),
  );
  await app.ready;
  const cards = app.element("results").children;
  assert.equal(cards.length, 4);
  for (const [index, code] of ["ART", "CAP", "MCP", "APP"].entries()) {
    assert.equal(cards[index].children[0].children[1].textContent, code);
    assert.match(content(cards[index]), /暂无内容预览/);
    assert.ok(content(cards[index]).includes(items[index].title));
    assert.match(content(cards[index]), /798 B/);
    assert.match(content(cards[index]), /未扫描/);
    assert.doesNotMatch(content(cards[index]), /评分|热门|免费下载/);
  }
  assert.equal(app.element("empty").hidden, true);
  assert.equal(app.element("transfer-open").hidden, true);
});

test("分类、搜索和下一页共享当前过滤条件，切换不会自动扫描后续页", async (t) => {
  const app = await store(t, (path) =>
    Response.json(
      path === "/auth/session"
        ? { enabled: true }
        : { items: [sample("mcp")], nextAfter: "next-page" },
    ),
  );
  await app.ready;
  app.element("query").value = "  工具%_  ";
  await click(app.element("category-mcp"));
  assert.equal(app.element("category-mcp").attributes.get("aria-pressed"), "true");
  assert.equal(app.element("category-all").attributes.get("aria-pressed"), "false");
  assert.equal(app.element("heading").textContent, "搜索结果");
  assert.equal(app.element("discovery").hidden, true);
  assert.match(app.element("filter-summary").textContent, /工具%_/);
  await click(app.element("more"));
  const query = new URL(app.requests.at(-1).path, "https://example.test").searchParams;
  assert.equal(query.get("kind"), "mcp");
  assert.equal(query.get("q"), "工具%_");
  assert.equal(query.get("after"), "next-page");
  assert.equal(app.requests.length, 4);
  await click(app.element("category-all"));
  assert.equal(
    new URL(app.requests.at(-1).path, "https://example.test").searchParams.has("kind"),
    false,
  );
});

test("空候选页保留可用的手动下一页，真实空目录才显示无匹配", async (t) => {
  const app = await store(t, (path) =>
    Response.json(
      path === "/auth/session"
        ? { enabled: true }
        : { items: [], nextAfter: path.includes("after=") ? null : "next-page" },
    ),
  );
  await app.ready;
  assert.equal(app.element("empty").hidden, false);
  assert.equal(app.element("more").disabled, false);
  assert.equal(app.element("empty-title").textContent, "本页没有可用资产");
  assert.equal(app.requests.length, 2);
  await click(app.element("more"));
  assert.equal(app.element("more").disabled, true);
  assert.equal(app.element("empty-title").textContent, "没有匹配的资产");
});

test("详情模态展示完整摘要和风险，关闭后恢复卡片焦点，访客不能下载", async (t) => {
  const item = sample();
  const app = await store(t, (path) =>
    Response.json(
      path === "/auth/session"
        ? { enabled: true }
        : path.includes(item.id)
          ? item
          : { items: [item], nextAfter: null },
    ),
  );
  await app.ready;
  const button = app.element("results").children[0].children[1].children.at(-1).children[1];
  await click(button);
  assert.equal(app.element("detail").open, true);
  assert.equal(globalThis.document.activeElement, app.element("detail-close"));
  assert.equal(app.element("download").disabled, true);
  assert.equal(app.element("login-hint").hidden, false);
  assert.match(content(app.element("facts")), /未进行恶意代码扫描/);
  assert.ok(content(app.element("facts")).includes(item.sha256));
  click(app.element("detail-close"));
  assert.equal(app.element("detail").open, false);
  assert.equal(globalThis.document.activeElement, button);
});

test("私库身份失效关闭详情并清空卡片，不自动重试私有请求", async (t) => {
  const item = sample();
  const app = await store(t, (path) =>
    path.startsWith("/v1/me/library")
      ? Response.json({ error: "UNAUTHENTICATED" }, { status: 401 })
      : Response.json(
          path === "/auth/session"
            ? { enabled: true, principal: "owner", csrf: "a".repeat(64) }
            : path.includes(item.id)
              ? item
              : { items: [item], nextAfter: null },
        ),
  );
  await app.ready;
  await click(app.element("results").children[0].children[1].children.at(-1).children[1]);
  await click(app.element("library"));
  assert.equal(app.element("detail").open, false);
  assert.equal(app.element("results").children.length, 0);
  assert.equal(app.element("library").disabled, true);
  assert.equal(app.element("public").attributes.get("aria-pressed"), "true");
  assert.equal(app.element("transfer-open").hidden, true);
  assert.equal(app.requests.length, 4);
});

test("未完成下载可关闭重开，浏览其他资产不把原任务挂到新详情", async (t) => {
  const item = {
    ...sample("application"),
    title: "原下载资产",
    size: 300000,
    versionId: "22222222-2222-4222-8222-222222222222",
  };
  const other = { ...sample("mcp"), id: "33333333-3333-4333-8333-333333333333", title: "其他资产" };
  const path = `/v1/publications/${item.id}/content`;
  let started, release;
  const contentStarted = new Promise((resolve) => {
    started = resolve;
  });
  const held = new Promise((resolve) => {
    release = resolve;
  });
  const app = await store(t, async (url, options) => {
    if (url === path) {
      if (options.headers.Range === "bytes=0-262143")
        return new Response(new Uint8Array(262144), {
          status: 206,
          headers: {
            "content-type": "application/zip",
            "content-range": "bytes 0-262143/300000",
            etag: '"sample"',
          },
        });
      started();
      await held;
      return Response.json({ error: "TEST_UNAVAILABLE" }, { status: 503 });
    }
    return Response.json(
      url === "/auth/session"
        ? { enabled: true, principal: "owner", csrf: "a".repeat(64) }
        : url.endsWith("/tickets")
          ? { publicationId: item.id, contentPath: path, ticket: "c".repeat(64) }
          : url.endsWith(item.id)
            ? item
            : url.endsWith(other.id)
              ? other
              : { items: [item, other], nextAfter: null },
    );
  });
  await app.ready;
  const cardButton = (index) =>
    app.element("results").children[index].children[1].children.at(-1).children[1];
  await click(cardButton(0));
  const downloading = click(app.element("download"));
  await contentStarted;
  assert.equal(app.element("detail-close").disabled, false);
  assert.equal(app.element("transfer-stop").disabled, false);
  click(app.element("detail-close"));
  assert.equal(globalThis.document.activeElement, app.element("transfer-open"));
  click(app.element("transfer-open"));
  assert.equal(app.element("detail").open, true);
  assert.equal(app.element("detail-title").textContent, item.title);
  // 已交付一个完整分段；第二段的传输故障保留可手动继续的原任务。
  release();
  await downloading;
  assert.equal(app.element("transfer-open").hidden, false);
  assert.equal(app.element("resume").disabled, false);
  click(app.element("detail-close"));
  await click(cardButton(1));
  assert.equal(app.element("detail-title").textContent, other.title);
  assert.equal(app.element("transfer").hidden, true);
  click(app.element("detail-close"));
  const requests = app.requests.length;
  click(app.element("transfer-open"));
  assert.equal(app.element("detail-title").textContent, item.title);
  assert.equal(app.element("transfer").hidden, false);
  assert.equal(app.requests.length, requests);
  click(app.element("transfer-stop"));
  assert.equal(app.element("transfer-open").hidden, true);
  click(app.element("detail-close"));
  assert.equal(globalThis.document.activeElement, app.element("query"));
});

test("未配置账号时隐藏详情登录入口，正式入口仍使用同源原生 POST", async (t) => {
  const app = await store(t, (path) =>
    Response.json(
      path === "/auth/session"
        ? { enabled: false, principal: null }
        : { items: [], nextAfter: null },
    ),
  );
  await app.ready;
  assert.equal(app.element("login-hint").hidden, true);
  const html = await readFile(new URL("../src/web/store.html", import.meta.url), "utf8");
  assert.match(html, /<form id="store-login-hint" action="\/auth\/login" method="post" hidden>/);
  assert.doesNotMatch(html, /本地体验身份/);
});
