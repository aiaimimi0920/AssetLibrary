import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { coreModules } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { png } from "./inspection-fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { complete, put, sha256 } from "./upload-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

async function publishWithCover(f, coverBytes) {
  const created = await f.request("POST", "/v1/resources", {
    kind: "art",
    title: "缓存与防刷验证素材",
  });
  assert.equal(created.status, 201);
  let rev = created.body.revision;
  const coverRes = await f.mf.dispatchFetch(
    `http://localhost/v1/resources/${created.body.id}/cover?revision=${rev}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${await f.token()}`,
        "content-type": "image/png",
        "idempotency-key": randomUUID(),
      },
      body: coverBytes,
    },
  );
  assert.equal(coverRes.status, 200);
  rev = (await coverRes.json()).revision;

  const zipBytes = packageBytes();
  const reserved = await f.request("POST", `/v1/resources/${created.body.id}/uploads`, {
    size: zipBytes.length,
    sha256: sha256(zipBytes),
  });
  assert.equal(reserved.status, 201);
  assert.equal((await put(f, reserved.body, zipBytes)).status, 200);
  assert.equal((await complete(f, reserved.body)).status, 200);
  assert.equal((await startPackage(f, reserved.body, "art-zip-manifest-v1")).status, 201);
  await runScanner(f, {
    fetch() {
      throw new Error("SCANNER_NOT_EXPECTED");
    },
  });
  const version = await createVersion(f, reserved.body);
  assert.equal(version.status, 201);
  const approved = await review(f, version.body);
  assert.equal(approved.status, 200);
  const published = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
    revision: approved.body.revision,
  });
  assert.equal(published.status, 201);
  return {
    resourceId: created.body.id,
    versionId: version.body.id,
    publication: published.body,
  };
}

test("公开封面 ?v= 与 If-None-Match 命中 304 时零 R2 读取，私有封面与下载保持 no-store", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const coverBytes = png(16, 16);
    const { resourceId, versionId, publication } = await publishWithCover(f, coverBytes);

    const { publicCover } = await coreModules();
    let r2Reads = 0;
    const countedBucket = {
      get: (...args) => {
        r2Reads += 1;
        return f.bucket.get(...args);
      },
      head: (...args) => {
        r2Reads += 1;
        return f.bucket.head(...args);
      },
    };

    const first = await publicCover(
      f.db,
      countedBucket,
      publication.id,
      false,
      undefined,
      new Request(`http://localhost/v1/catalog/${publication.id}/cover`),
    );
    assert.equal(first.status, 200);
    assert.equal(r2Reads, 1);
    const etag = first.headers.get("etag");
    assert.equal(etag, `"${sha256(coverBytes)}"`);
    assert.equal(
      first.headers.get("cache-control"),
      "public, max-age=60, s-maxage=300, stale-while-revalidate=60",
    );
    await first.arrayBuffer();

    const notModified = await publicCover(
      f.db,
      countedBucket,
      publication.id,
      false,
      undefined,
      new Request(`http://localhost/v1/catalog/${publication.id}/cover`, {
        headers: { "if-none-match": `W/${etag}` },
      }),
    );
    assert.equal(notModified.status, 304);
    assert.equal(r2Reads, 1, "304 命中不得触发任何 R2 get/head 操作");

    const versioned = await f.mf.dispatchFetch(
      `http://localhost/v1/catalog/${publication.id}/cover?v=${sha256(coverBytes).slice(0, 16)}`,
    );
    assert.equal(versioned.status, 200);
    await versioned.arrayBuffer();

    for (const invalidQuery of ["?v=XYZ", "?other=1", "?v=abcd&extra=1"]) {
      const rejected = await f.mf.dispatchFetch(
        `http://localhost/v1/catalog/${publication.id}/cover${invalidQuery}`,
      );
      assert.equal(rejected.status, 400);
      assert.equal((await rejected.json()).error, "INVALID_QUERY");
    }

    // 私有封面与我的资源库必须保持 no-store，不被公开缓存策略污染。
    for (const privateCoverPath of [
      `/v1/resources/${resourceId}/cover`,
      `/v1/versions/${versionId}/cover`,
    ]) {
      const res = await f.mf.dispatchFetch(`http://localhost${privateCoverPath}`, {
        headers: { authorization: `Bearer ${await f.token()}` },
      });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      await res.arrayBuffer();
    }
    const myLibrary = await f.request("GET", "/v1/me/library");
    assert.equal(myLibrary.status, 200);
    assert.equal(myLibrary.headers.get("cache-control"), "no-store");
  } finally {
    await f.dispose();
  }
});

test("匿名目录与求购广场支持 ETag/304 及有界边缘缓存，且绝不影响下载票据实时撤销", async () => {
  const f = await fixture({
    reviewers: reviewerConfig,
    textEnv: {
      PUBLIC_EDGE_CACHE_SECONDS: "10",
      COVER_EDGE_CACHE_SECONDS: "300",
    },
  });
  try {
    const coverBytes = png(12, 12);
    const { publication } = await publishWithCover(f, coverBytes);
    const reqCreated = await f.request("POST", "/v1/asset-requests", {
      title: "边缘缓存测试求购",
      category: "images",
      style: "pixel",
      space: "general",
      formats: ["PNG"],
      license: "commercial",
      periodDays: 7,
      budgetNote: "共创",
      description: "测试匿名求购列表 ETag 与边缘微缓存。",
      delivery: "PNG",
    });
    assert.equal(reqCreated.status, 201);

    for (const publicPath of [
      "/v1/catalog?limit=20",
      `/v1/catalog/${publication.id}`,
      "/v1/asset-requests?limit=20",
      `/v1/asset-requests/${reqCreated.body.id}`,
    ]) {
      const miss = await f.mf.dispatchFetch(`http://localhost${publicPath}`, {
        headers: { cookie: "ignored=1" },
      });
      assert.equal(miss.status, 200, publicPath);
      assert.equal(
        miss.headers.get("cache-control"),
        "public, max-age=5, s-maxage=60, stale-while-revalidate=300",
      );
      const etag = miss.headers.get("etag");
      assert.match(etag ?? "", /^"[0-9a-f]{32}"$/);
      await miss.text();

      const hit = await f.mf.dispatchFetch(`http://localhost${publicPath}`);
      assert.equal(hit.status, 200);
      assert.equal(hit.headers.get("etag"), etag);
      if (miss.headers.get("x-traffic-cache")) {
        assert.equal(miss.headers.get("x-traffic-cache"), "MISS");
        assert.equal(hit.headers.get("x-traffic-cache"), "HIT");
      }
      await hit.text();

      const revalidated = await f.mf.dispatchFetch(`http://localhost${publicPath}`, {
        headers: { "if-none-match": etag },
      });
      assert.equal(revalidated.status, 304);
      assert.equal(await revalidated.text(), "");
    }

    // 下架后，即使边缘短缓存仍在 10 秒残留窗口内，私有下载票据申请与包体流也必须 0 秒立即拒绝！
    const grantRes = await f.request("PUT", `/v1/publications/${publication.id}/grants/user:bob`, {
      revision: 0,
    });
    assert.equal(grantRes.status, 200);
    const ticketBefore = await f.request(
      "POST",
      `/v1/publications/${publication.id}/tickets`,
      {},
      { principal: "user:bob" },
    );
    assert.equal(ticketBefore.status, 201);
    assert.equal(ticketBefore.headers.get("cache-control"), "no-store");

    const unlisted = await f.request("POST", `/v1/publications/${publication.id}/unlist`, {
      revision: 1,
    });
    assert.equal(unlisted.status, 200);

    const ticketAfter = await f.request(
      "POST",
      `/v1/publications/${publication.id}/tickets`,
      {},
      { principal: "user:bob" },
    );
    assert.equal(ticketAfter.status, 404);
    const contentAfter = await f.mf.dispatchFetch(
      `http://localhost/v1/publications/${publication.id}/content`,
      {
        headers: {
          authorization: `Bearer ${await f.token("user:bob")}`,
          "x-download-ticket": ticketBefore.body.ticket,
        },
      },
    );
    assert.equal(contentAfter.status, 404);
  } finally {
    await f.dispose();
  }
});

test("防刷护栏：超长 URL 414、按 IP 分桶 429、IPv6 /64 归并、内存上限淘汰与原生 ratelimit 绑定", async () => {
  const { enforceTrafficGuard, normalizeClientIp, RateLimitError, resetMemoryRateLimits } =
    await coreModules();
  resetMemoryRateLimits();

  assert.equal(normalizeClientIp("203.0.113.42"), "203.0.113.42");
  assert.equal(normalizeClientIp("2001:db8:abcd:0012::1"), "2001:0db8:abcd:0012::/64");
  assert.equal(
    normalizeClientIp("2001:0DB8:ABCD:12:ffff:eeee:dddd:cccc"),
    "2001:0db8:abcd:0012::/64",
  );

  // IPv6 同一 /64 子网轮换不同接口后缀必须共享同一限流配额
  const env = {
    RATE_LIMIT_PUBLIC_PER_MIN: "2",
    RATE_LIMIT_AUTH_PER_MIN: "1",
    RATE_LIMIT_WRITE_PER_MIN: "1",
  };
  const now = 1_700_000_000_000;
  await enforceTrafficGuard(
    new Request("http://localhost/v1/catalog", {
      headers: { "CF-Connecting-IP": "2001:db8:1111:2222::1" },
    }),
    env,
    now,
  );
  await enforceTrafficGuard(
    new Request("http://localhost/v1/catalog", {
      headers: { "CF-Connecting-IP": "2001:db8:1111:2222::9999" },
    }),
    env,
    now + 100,
  );
  await assert.rejects(
    () =>
      enforceTrafficGuard(
        new Request("http://localhost/v1/catalog", {
          headers: { "CF-Connecting-IP": "2001:db8:1111:2222:aaaa:bbbb:cccc:dddd" },
        }),
        env,
        now + 200,
      ),
    (err) => err instanceof RateLimitError && err.status === 429 && err.retryAfter === 60,
  );

  // 窗口到期后自动恢复
  await enforceTrafficGuard(
    new Request("http://localhost/v1/catalog", {
      headers: { "CF-Connecting-IP": "2001:db8:1111:2222::1" },
    }),
    env,
    now + 60_001,
  );

  // 2500 个随机 IP 洪泛下有界淘汰，不抛异常、不无限增长，且旧最早键被驱逐
  resetMemoryRateLimits();
  for (let i = 0; i < 2500; i++) {
    const a = Math.floor(i / 256);
    const b = i % 256;
    await enforceTrafficGuard(
      new Request("http://localhost/v1/catalog", {
        headers: { "CF-Connecting-IP": `198.51.${a}.${b}` },
      }),
      { RATE_LIMIT_PUBLIC_PER_MIN: "1" },
      now,
    );
  }
  // 最后一个 IP（仍在有界窗口内）第二次访问应触发 429
  await assert.rejects(
    () =>
      enforceTrafficGuard(
        new Request("http://localhost/v1/catalog", {
          headers: { "CF-Connecting-IP": "198.51.9.195" },
        }),
        { RATE_LIMIT_PUBLIC_PER_MIN: "1" },
        now + 10,
      ),
    RateLimitError,
  );

  // 原生 Cloudflare ratelimit 绑定拒绝时也返回 429
  resetMemoryRateLimits();
  let nativeKey = "";
  await assert.rejects(
    () =>
      enforceTrafficGuard(
        new Request("http://localhost/auth/login", {
          method: "POST",
          headers: { "CF-Connecting-IP": "192.0.2.88" },
        }),
        {
          RATE_LIMIT_AUTH: {
            async limit({ key }) {
              nativeKey = key;
              return { success: false };
            },
          },
        },
        now,
      ),
    RateLimitError,
  );
  assert.equal(nativeKey, "auth:192.0.2.88");

  // 完整 Worker 集成验证：414 超长 URL 与 429 Retry-After 响应头
  const f = await fixture({
    textEnv: { RATE_LIMIT_PUBLIC_PER_MIN: "2" },
  });
  try {
    const tooLong = await f.mf.dispatchFetch(`http://localhost/v1/catalog?q=${"a".repeat(2100)}`);
    assert.equal(tooLong.status, 414);
    assert.equal((await tooLong.json()).error, "URI_TOO_LONG");

    const ipHeaders = { "CF-Connecting-IP": "203.0.113.77" };
    assert.equal(
      (await f.mf.dispatchFetch("http://localhost/v1/catalog", { headers: ipHeaders })).status,
      200,
    );
    assert.equal(
      (await f.mf.dispatchFetch("http://localhost/v1/catalog", { headers: ipHeaders })).status,
      200,
    );
    const limited = await f.mf.dispatchFetch("http://localhost/v1/catalog", { headers: ipHeaders });
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("cache-control"), "no-store");
    assert.match(limited.headers.get("retry-after") ?? "", /^[1-9][0-9]*$/);
    assert.deepEqual(await limited.json(), { error: "RATE_LIMITED" });

    // 静态页面不受公开 API 限流桶阻断
    const home = await f.mf.dispatchFetch("http://localhost/", { headers: ipHeaders });
    assert.equal(home.status, 200);
    await home.text();
  } finally {
    await f.dispose();
  }
});

test("前端公开读取启用浏览器 HTTP 缓存模式，封面图片附带短摘要指纹与异步解码", async () => {
  const prevDoc = globalThis.document;
  const makeFakeNode = (tag) => ({
    tagName: tag.toUpperCase(),
    textContent: "",
    className: "",
    attributes: new Map(),
    children: [],
    setAttribute(name, value) {
      this.attributes.set(name, value);
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    append(...items) {
      this.children.push(...items);
    },
  });
  globalThis.document = { createElement: makeFakeNode };
  try {
    const { renderStoreCover } = await import("../src/web/store-view.client.js");
    const node = renderStoreCover(
      {
        kind: "art",
        cover: {
          url: "/v1/catalog/00000000-0000-4000-8000-000000000001/cover",
          sha256: "abcdef0123456789fedcba9876543210abcdef0123456789fedcba9876543210",
          width: 320,
          height: 180,
        },
      },
      { art: "Art 素材" },
      { art: "ART" },
    );
    const img = node.children.find((child) => child.tagName === "IMG");
    assert.ok(img);
    assert.equal(
      img.getAttribute("src"),
      "/v1/catalog/00000000-0000-4000-8000-000000000001/cover?v=abcdef0123456789",
    );
    assert.equal(img.getAttribute("loading"), "lazy");
    assert.equal(img.getAttribute("decoding"), "async");
  } finally {
    if (prevDoc === undefined) delete globalThis.document;
    else globalThis.document = prevDoc;
  }

  const seenModes = [];
  const origFetch = globalThis.fetch;
  globalThis.fetch = async (_url, init) => {
    seenModes.push(init.cache);
    return new Response(JSON.stringify({ items: [], nextAfter: null }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  try {
    const { api, setCredential } = await import("../src/web/api.client.js");
    await api("/v1/catalog?limit=20", { publicRead: true });
    await api("/v1/catalog?limit=20", { publicRead: true, reload: true });
    setCredential("synthetic-jwt");
    await api("/v1/me/library?limit=20");
    setCredential("");
    assert.deepEqual(seenModes, ["default", "no-cache", "no-store"]);
  } finally {
    globalThis.fetch = origFetch;
  }
});
