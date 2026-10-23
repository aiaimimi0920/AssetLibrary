import assert from "node:assert/strict";
import test from "node:test";
import { naccountFixture } from "./naccount-fixture.mjs";

test("并发冷启动共享一次 JWKS 读取，不合并在线 userinfo 校验", async () => {
  const f = await naccountFixture();
  let release;
  try {
    const flows = await Promise.all([f.start(), f.start()]);
    let entered;
    const arrived = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.remote.keysGate = async () => {
      entered();
      await gate;
    };
    const requests = flows.map((flow) => f.request(flow.path, { cookie: flow.flowCookie }));
    await arrived;
    release();
    for (const response of await Promise.all(requests))
      assert.equal(response.headers.get("location"), "https://assetlibrary.test");
    assert.equal(f.remote.calls.filter((url) => url.endsWith("jwks.json")).length, 1);
    assert.equal(f.remote.calls.filter((url) => url.endsWith("userinfo")).length, 2);
  } finally {
    release?.();
    await f.dispose();
  }
});

test("升级前加密的纯 verifier 事务仍可在五分钟窗口内完成", async () => {
  const f = await naccountFixture();
  try {
    const flow = await f.start();
    const row = await f.db.prepare("SELECT * FROM auth_transactions").first();
    const key = await crypto.subtle.importKey(
      "raw",
      Buffer.from(f.env.NACCOUNT_SESSION_KEY, "hex"),
      "AES-GCM",
      false,
      ["decrypt", "encrypt"],
    );
    const [oldIv, data] = row.verifier.split(".").map((value) => Buffer.from(value, "base64"));
    const additionalData = new TextEncoder().encode(`login:${row.state_hash}`);
    const decoded = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: oldIv, additionalData },
      key,
      data,
    );
    const { verifier } = JSON.parse(new TextDecoder().decode(decoded));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const sealed = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData },
      key,
      new TextEncoder().encode(verifier),
    );
    await f.db
      .prepare("UPDATE auth_transactions SET verifier = ? WHERE state_hash = ?")
      .bind(
        `${Buffer.from(iv).toString("base64")}.${Buffer.from(sealed).toString("base64")}`,
        row.state_hash,
      )
      .run();
    const response = await f.request(flow.path, { cookie: flow.flowCookie });
    assert.equal(response.headers.get("location"), "https://assetlibrary.test");
    assert.equal(f.remote.verifier, verifier);
  } finally {
    await f.dispose();
  }
});

test("登录只允许固定工作台回跳，拒绝重复参数和外部地址且不创建事务", async () => {
  const f = await naccountFixture();
  try {
    for (const query of [
      "returnTo=https://evil.test",
      "returnTo=//evil.test",
      "returnTo=/workspace",
      "returnTo=",
      "returnTo=workspace&returnTo=workspace",
      "next=workspace",
    ]) {
      const response = await f.request(`/auth/login?${query}`, { method: "POST" });
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { error: "AUTH_RETURN_REJECTED" });
    }
    assert.equal((await f.db.prepare("SELECT count(*) AS n FROM auth_transactions").first()).n, 0);
    for (const [path, expected] of [
      ["/auth/login", "https://assetlibrary.test"],
      ["/auth/login?returnTo=workspace", "https://assetlibrary.test/workspace"],
    ]) {
      const flow = await f.start(path);
      const response = await f.request(flow.path, { cookie: flow.flowCookie });
      assert.equal(response.headers.get("location"), expected);
    }
  } finally {
    await f.dispose();
  }
});

test("未知 kid 刷新有冷却，轮换后可重新加载；有效旧 key 不等待失败刷新", async () => {
  const f = await naccountFixture();
  const now = Date.now;
  let release;
  try {
    const login = await f.login();
    const count = () => f.remote.calls.filter((url) => url.endsWith("jwks.json")).length;
    assert.equal(count(), 1);
    await f.rotateKey();
    let flow = await f.start();
    assert.match(
      (await f.request(flow.path, { cookie: flow.flowCookie })).headers.get("location"),
      /auth=failed/,
    );
    assert.equal(count(), 1);
    Date.now = () => now() + 31000;
    let entered;
    const arrived = new Promise((resolve) => {
      entered = resolve;
    });
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    f.remote.keysGate = async () => {
      entered();
      await gate;
    };
    f.remote.keysFail = true;
    flow = await f.start();
    const refreshing = f.request(flow.path, { cookie: flow.flowCookie });
    await arrived;
    assert.equal((await f.request("/v1/me", login)).status, 200);
    release();
    assert.match((await refreshing).headers.get("location"), /auth=failed/);
    f.remote.keysGate = undefined;
    flow = await f.start();
    await f.request(flow.path, { cookie: flow.flowCookie });
    assert.equal(count(), 2, "失败刷新也受 30 秒冷却");
    f.remote.keysFail = false;
    Date.now = () => now() + 62000;
    flow = await f.start();
    assert.equal(
      (await f.request(flow.path, { cookie: flow.flowCookie })).headers.get("location"),
      "https://assetlibrary.test",
    );
    assert.equal(count(), 3);
  } finally {
    release?.();
    Date.now = now;
    await f.dispose();
  }
});
