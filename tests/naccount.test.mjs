import assert from "node:assert/strict";
import test from "node:test";
import { naccountFixture } from "./naccount-fixture.mjs";

test("NAccount PKCE 登录使用真实 authId 合同、加密会话和一次性 state", async () => {
  const f = await naccountFixture();
  try {
    const login = await f.login();
    assert.equal(login.principal, "naccount-user-1");
    assert.match(login.csrf, /^[0-9a-f]{64}$/);
    const rows = (await f.db.prepare("SELECT * FROM auth_sessions").all()).results;
    assert.equal(rows.length, 1);
    assert.notEqual(rows[0].access_token, f.remote.token);
    assert.ok(!JSON.stringify(rows).includes(f.remote.token));
    assert.equal((await f.request(login.path, { cookie: login.flowCookie })).status, 400);
    const me = await f.request("/v1/me", login);
    assert.deepEqual(await me.json(), { principal: login.principal });
    const resource = await f.request("/v1/resources", {
      ...login,
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
      body: JSON.stringify({ kind: "art", title: "真实身份合同资源" }),
    });
    assert.equal(resource.status, 201);
  } finally {
    await f.dispose();
  }
});

test("跨站登录、错误浏览器绑定和 CSRF 不得产生业务变更", async () => {
  const f = await naccountFixture();
  try {
    for (const origin of ["https://evil.test", "null", null]) {
      const rejected = await f.request("/auth/login", {
        method: "POST",
        headers: { Origin: origin },
      });
      assert.equal(rejected.status, 403);
      assert.deepEqual(await rejected.json(), { error: "AUTH_ORIGIN_REJECTED" });
      assert.equal(rejected.headers.get("set-cookie"), null);
    }
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM auth_transactions").first()).n, 0);
    assert.equal(f.remote.calls.length, 0);
    const flow = await f.start();
    assert.equal(
      (await f.request(flow.path, { cookie: `__Host-assetlibrary-login=${"0".repeat(64)}` }))
        .status,
      400,
    );
    const login = await f.login();
    for (const overrides of [{ csrf: undefined }, { headers: { Origin: "https://evil.test" } }]) {
      assert.equal(
        (await f.request("/v1/resources", { ...login, method: "POST", ...overrides })).status,
        403,
      );
    }
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM resources").first()).n, 0);
  } finally {
    await f.dispose();
  }
});

test("拒绝其他客户端、服务令牌、冒充身份和不匹配的 userinfo", async () => {
  const f = await naccountFixture();
  try {
    for (const [key, value] of [
      ["azp", "another-client"],
      ["tokenType", "service"],
      ["impersonatedBy", "admin"],
      ["scope", "openid"],
    ]) {
      const before = f.remote.claims[key];
      f.remote.claims[key] = value;
      const flow = await f.start();
      const response = await f.request(flow.path, { cookie: flow.flowCookie });
      assert.match(response.headers.get("location"), /auth=failed$/);
      if (before === undefined) delete f.remote.claims[key];
      else f.remote.claims[key] = before;
    }
    f.remote.authId = "different-user";
    const flow = await f.start();
    assert.match(
      (await f.request(flow.path, { cookie: flow.flowCookie })).headers.get("location"),
      /auth=failed$/,
    );
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM auth_sessions").first()).n, 0);
  } finally {
    await f.dispose();
  }
});

test("账号撤销即时拒绝且失效会话不复活，服务中断失败关闭但保留会话", async () => {
  const f = await naccountFixture();
  try {
    const login = await f.login();
    f.remote.available = false;
    assert.equal((await f.request("/v1/me", login)).status, 503);
    f.remote.available = true;
    assert.equal((await f.request("/v1/me", login)).status, 200);
    f.remote.active = false;
    assert.equal((await f.request("/v1/me", login)).status, 401);
    f.remote.active = true;
    assert.equal((await f.request("/v1/me", login)).status, 401);
  } finally {
    await f.dispose();
  }
});

test("退出删除服务端会话，旧 cookie、旧 Bearer 和过期事务不能恢复身份", async () => {
  const f = await naccountFixture();
  try {
    const login = await f.login();
    const result = await f.request("/auth/logout", { ...login, method: "POST" });
    assert.equal(result.status, 200);
    assert.match((await result.json()).logoutUrl, /\/oauth2\/v1\/logout\?/);
    assert.match(result.headers.get("set-cookie"), /Max-Age=0/);
    assert.equal((await f.request("/v1/me", login)).status, 401);
    assert.equal(
      (await f.request("/v1/me", { headers: { Authorization: `Bearer ${await f.token()}` } }))
        .status,
      401,
    );
    const flow = await f.start();
    await f.db.prepare("UPDATE auth_transactions SET expires_at=0").run();
    assert.equal((await f.request(flow.path, { cookie: flow.flowCookie })).status, 400);
  } finally {
    await f.dispose();
  }
});

test("跨标签页的新 cookie 不能被旧页面的 CSRF 身份读取", async () => {
  const f = await naccountFixture();
  try {
    const first = await f.login();
    f.remote.claims.sub = "naccount-user-2";
    f.remote.authId = "naccount-user-2";
    const second = await f.login();
    assert.equal(
      (await f.request("/v1/me", { cookie: second.cookie, csrf: first.csrf })).status,
      403,
    );
    assert.equal((await f.request("/v1/me", second)).status, 200);
  } finally {
    await f.dispose();
  }
});

test("退出取消已经进入令牌交换的登录，迟到 callback 不得复活会话", async () => {
  const f = await naccountFixture();
  let release;
  try {
    const login = await f.login();
    const flow = await f.start();
    let entered;
    const arrived = new Promise((resolve) => {
      entered = resolve;
    });
    const paused = new Promise((resolve) => {
      release = resolve;
    });
    f.remote.tokenGate = async () => {
      entered();
      await paused;
    };
    const completing = f.request(flow.path, { cookie: flow.flowCookie });
    await arrived;
    const logout = await f.request("/auth/logout", {
      method: "POST",
      csrf: login.csrf,
      cookie: `${login.cookie}; ${flow.flowCookie}`,
    });
    assert.equal(logout.status, 200);
    release();
    const callback = await completing;
    assert.match(callback.headers.get("location"), /auth=failed$/);
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM auth_sessions").first()).n, 0);
  } finally {
    release?.();
    await f.dispose();
  }
});
