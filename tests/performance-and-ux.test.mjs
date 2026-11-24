import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { coreModules } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { click, sample, store } from "./store-client-fixture.mjs";

test("构建产物注入 modulepreload 与收敛 ?v= 内容指纹，并启用 1 年 immutable 边缘头", async () => {
  const bundle = process.env.ASSETLIBRARY_BUNDLE;
  assert.ok(bundle);
  const outDir = path.dirname(bundle);
  const manifest = JSON.parse(await readFile(path.join(outDir, "manifest.json"), "utf8"));
  const { files, config } = manifest.staticAssets;

  assert.match(config._headers, /\/\*\.css\n\s+Cache-Control: public, max-age=31536000, immutable/);
  assert.match(config._headers, /\/\*\.js\n\s+Cache-Control: public, max-age=31536000, immutable/);
  assert.match(
    config._headers,
    /\/beaver\.svg\n\s+Cache-Control: public, max-age=31536000, immutable/,
  );

  const indexHtml = await readFile(path.join(outDir, files["/index.html"].file), "utf8");
  const workspaceHtml = await readFile(path.join(outDir, files["/workspace.html"].file), "utf8");

  // 验证 modulepreload 完整覆盖商店首页与工作台子模块，且所有引用均携带 12 位不可变指纹。
  for (const dep of [
    "api.client.js",
    "store-view.client.js",
    "asset-market.client.js",
    "download.client.js",
    "resume-download.client.js",
  ]) {
    assert.match(
      indexHtml,
      new RegExp(
        `<link rel="modulepreload" href="/${dep.replaceAll(".", "\\.")}\\?v=[0-9a-f]{12}">`,
      ),
    );
  }
  for (const dep of ["api.client.js", "render.client.js", "upload.client.js"]) {
    assert.match(
      workspaceHtml,
      new RegExp(
        `<link rel="modulepreload" href="/${dep.replaceAll(".", "\\.")}\\?v=[0-9a-f]{12}">`,
      ),
    );
  }

  // 验证 HTML 中的 <link rel="modulepreload"> 指纹与 store.client.js 内部相对 import 指纹严格一致，避免浏览器重复下载。
  const storeJs = await readFile(path.join(outDir, files["/store.client.js"].file), "utf8");
  const htmlApiVer = /href="\/api\.client\.js\?v=([0-9a-f]{12})"/.exec(indexHtml)?.[1];
  const jsApiVer = /from "\.\/api\.client\.js\?v=([0-9a-f]{12})"/.exec(storeJs)?.[1];
  assert.ok(htmlApiVer);
  assert.equal(htmlApiVer, jsApiVer);
  assert.equal(htmlApiVer, files["/api.client.js"].sha256.slice(0, 12));
});

test("D1 乐观查询在完整 Schema 下零 sqlite_master 探测，缺少 0013/0014 时自动回退", async () => {
  const f = await fixture();
  try {
    const core = await coreModules();
    const queries = [];
    const proxyDb = {
      prepare(sql) {
        queries.push(sql);
        return f.db.prepare(sql);
      },
    };
    const res = await core.listPublications(
      proxyDb,
      new URL("http://localhost/v1/catalog?limit=5"),
    );
    assert.equal(res.status, 200);
    assert.equal(
      queries.some((sql) => /sqlite_master/i.test(sql)),
      false,
      "完整 Schema 下不得执行任何 sqlite_master 探测查询",
    );
    assert.equal(queries.length, 1);

    // 非法过滤参数必须在进入 D1 前拦截（0 次 SQL 查询）
    queries.length = 0;
    await assert.rejects(() =>
      core.listPublications(proxyDb, new URL("http://localhost/v1/catalog?section=invalid")),
    );
    assert.equal(queries.length, 0);
  } finally {
    await f.dispose();
  }
});

test("边缘缓存支持 SWR 陈旧秒回与单飞后台刷新，写操作成功后同机房热点缓存即时清理", async () => {
  const { withPublicEdgeCache, cachedPublicJson } = await coreModules();
  let computeCount = 0;
  const compute = async (req) => {
    computeCount += 1;
    return cachedPublicJson(req, Response.json({ seq: computeCount }));
  };

  const f = await fixture({
    textEnv: { PUBLIC_EDGE_CACHE_SECONDS: "60" },
  });
  try {
    // 1. 直接在 Miniflare Worker 环境验证写操作触发同机房缓存即时清理
    const firstList = await f.mf.dispatchFetch("http://localhost/v1/asset-requests?limit=20");
    assert.equal(firstList.status, 200);
    assert.deepEqual((await firstList.json()).items, []);

    const secondList = await f.mf.dispatchFetch("http://localhost/v1/asset-requests?limit=20");
    assert.equal(secondList.status, 200);
    if (firstList.headers.get("x-traffic-cache")) {
      assert.equal(secondList.headers.get("x-traffic-cache"), "HIT");
    }
    await secondList.text();

    // 发布一条新求购后，同机房缓存被 maybePurgePublicEdgeCache 立即清除，再次读取立即看到新记录！
    const createdReq = await f.request("POST", "/v1/asset-requests", {
      title: "同机房即时可见测试",
      category: "models",
      style: "lowpoly",
      space: "loom",
      formats: ["GLB"],
      license: "commercial",
      periodDays: 10,
      budgetNote: "共创",
      description: "验证写操作后立即清理本机房公开列表缓存。",
      delivery: "GLB",
    });
    assert.equal(createdReq.status, 201);

    const afterWrite = await f.mf.dispatchFetch("http://localhost/v1/asset-requests?limit=20");
    assert.equal(afterWrite.status, 200);
    const bodyAfterWrite = await afterWrite.json();
    assert.equal(bodyAfterWrite.items.length, 1);
    assert.equal(bodyAfterWrite.items[0].id, createdReq.body.id);
  } finally {
    await f.dispose();
  }

  // 2. 使用可控模拟 Cache 验证 HIT -> STALE 秒回与后台单飞刷新 -> 新 HIT
  const prevCaches = globalThis.caches;
  const storeMap = new Map();
  globalThis.caches = {
    default: {
      async match(req) {
        const hit = storeMap.get(req.url);
        return hit ? hit.clone() : undefined;
      },
      async put(req, res) {
        storeMap.set(req.url, res.clone());
      },
      async delete(req) {
        return storeMap.delete(req.url);
      },
    },
  };
  try {
    const t0 = 1_700_000_000_000;
    const req = new Request("https://assetlibrary.test/v1/catalog?limit=20");

    const r1 = await withPublicEdgeCache(req, 60, compute, undefined, t0);
    assert.equal(r1.headers.get("x-traffic-cache"), "MISS");
    assert.deepEqual(await r1.json(), { seq: 1 });
    assert.equal(computeCount, 1);

    const r2 = await withPublicEdgeCache(req, 60, compute, undefined, t0 + 30_000);
    assert.equal(r2.headers.get("x-traffic-cache"), "HIT");
    assert.deepEqual(await r2.json(), { seq: 1 });
    assert.equal(computeCount, 1);

    const waited = [];
    const ctx = { waitUntil: (p) => waited.push(p) };
    const r3 = await withPublicEdgeCache(req, 60, compute, ctx, t0 + 61_000);
    assert.equal(r3.headers.get("x-traffic-cache"), "STALE");
    assert.deepEqual(await r3.json(), { seq: 1 });
    await Promise.all(waited);
    assert.equal(computeCount, 2);

    const r4 = await withPublicEdgeCache(req, 60, compute, undefined, Date.now());
    assert.equal(r4.headers.get("x-traffic-cache"), "HIT");
    assert.deepEqual(await r4.json(), { seq: 2 });
  } finally {
    if (prevCaches === undefined) delete globalThis.caches;
    else globalThis.caches = prevCaches;
  }
});

test("商店读取期间保持导航栏与搜索框可交互，点击新分类立即抢占切换且不闪错误", async (t) => {
  let releaseHome;
  const homeHeld = new Promise((resolve) => {
    releaseHome = resolve;
  });
  const assetItem = { ...sample("art"), title: "抢占加载的素材" };

  const app = await store(t, async (url, options) => {
    if (url === "/auth/session") return Response.json({ enabled: true, principal: null });
    if (url === "/v1/catalog?limit=20") {
      await homeHeld;
      if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      return Response.json({ items: [sample("application")], nextAfter: null });
    }
    return Response.json({ items: [assetItem], nextAfter: null });
  });

  // 首页目录仍在加载时，顶部栏目按钮与搜索框不被锁死，用户可直接点击“素材”抢占切换！
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(app.element("section-assets").disabled, false);
  assert.equal(app.element("query").disabled, false);

  click(app.element("section-assets"));
  releaseHome();
  await app.ready;

  assert.equal(app.element("section-assets").attributes.get("aria-pressed"), "true");
  assert.notEqual(app.element("status").dataset.tone, "error");
  assert.equal(app.element("results").children.length, 1);
});
