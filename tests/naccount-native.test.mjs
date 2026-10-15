import assert from "node:assert/strict";
import test from "node:test";
import { naccountFixture } from "./naccount-fixture.mjs";

test("Loom 独立客户端使用 NAccount 主体创建并读取三类资源，网页会话保持", async () => {
  const f = await naccountFixture();
  try {
    const token = await f.issueToken({ azp: "loom-client" });
    const headers = { Authorization: `Bearer ${token}` };
    assert.equal((await f.request("/v1/me", { headers })).status, 401);
    f.env.NACCOUNT_NATIVE_CLIENT_ID = "loom-client";
    const identity = await f.request("/v1/me", { headers });
    assert.equal(identity.status, 200);
    assert.equal((await identity.json()).principal, "naccount-user-1");
    for (const kind of ["art", "capability", "application"]) {
      const response = await f.request("/v1/resources", {
        method: "POST",
        headers: {
          ...headers,
          "Content-Type": "application/json",
          "Idempotency-Key": crypto.randomUUID(),
          Origin: null,
        },
        body: JSON.stringify({ kind, title: `Loom ${kind}` }),
      });
      assert.equal(response.status, 201);
    }
    const list = await f.request("/v1/me/resources", { headers });
    assert.equal((await list.json()).items.length, 3);
    const browser = await f.login();
    assert.equal((await f.request("/v1/me", browser)).status, 200);
    assert.equal(
      (await f.request("/v1/me", { headers: { Authorization: `Bearer ${await f.issueToken()}` } }))
        .status,
      401,
    );
    f.remote.active = false;
    assert.equal((await f.request("/v1/me", { headers })).status, 401);
  } finally {
    await f.dispose();
  }
});
