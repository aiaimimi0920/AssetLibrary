import assert from "node:assert/strict";
import test from "node:test";
import { appFixture } from "./web-app-fixture.mjs";

test("恢复会话后首个私有请求失效时重新开放登录，不自动重定向", async (t) => {
  const app = await appFixture(t, (path) =>
    path === "/auth/session"
      ? Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) })
      : Response.json({ error: "UNAUTHENTICATED" }, { status: 401 }),
  );
  assert.equal(app.api.connected(), false);
  assert.equal(app.element("naccount-login").hidden, false);
  assert.match(app.element("notice").textContent, /重新登录/);
  assert.equal(app.requests.length, 2);
});

test("公开目录 401 不清除已登录用户的私有状态", async (t) => {
  const app = await appFixture(t, (path) => {
    if (path === "/auth/session")
      return Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) });
    if (path.startsWith("/v1/me/resources")) return Response.json({ items: [], nextCursor: null });
    return Response.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  });
  app.element("new-title").value = "保留草稿";
  await app.click("refresh-catalog");
  assert.equal(app.api.connected(), true);
  assert.equal(app.element("naccount-login").hidden, true);
  assert.equal(app.element("new-title").value, "保留草稿");
});

for (const [status, code, expires] of [
  [401, "UNAUTHENTICATED", true],
  [403, "FORBIDDEN", false],
  [503, "REVIEWERS_NOT_CONFIGURED", false],
]) {
  test(`真实应用事件处理 ${status} ${code} 的身份与视图`, async (t) => {
    const app = await appFixture(t, (path) => {
      if (path === "/auth/session")
        return Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) });
      if (path.startsWith("/v1/me/resources"))
        return Response.json({
          items: [{ id: "resource", title: "私有标题", owner: "owner", kind: "art" }],
          nextCursor: null,
        });
      return Response.json({ error: code }, { status });
    });
    assert.equal(app.api.connected(), true);
    assert.equal(app.element("naccount-login").hidden, true);
    for (const id of [
      "new-title",
      "resource-title",
      "member-principal",
      "review-id",
      "review-reason",
      "package-file",
      "publication-id",
      "grant-principal",
    ])
      app.element(id).value = "私有草稿";
    app.element("library").append({ textContent: "私有下载记录" });
    const operation = app.api.operationKey("create", { title: "draft" });
    await app.click("refresh-reviews");
    assert.equal(app.api.connected(), !expires);
    assert.equal(app.element("naccount-login").hidden, !expires);
    assert.equal(app.element("refresh-resources").disabled, expires);
    if (expires) {
      assert.equal(app.element("session-state").textContent, "未连接身份");
      assert.match(app.element("notice").textContent, /重新登录/);
      for (const id of [
        "new-title",
        "resource-title",
        "member-principal",
        "review-id",
        "review-reason",
        "package-file",
        "publication-id",
        "grant-principal",
      ])
        assert.equal(app.element(id).value, "", id);
      for (const id of ["uploads", "versions", "reviews", "library"])
        assert.equal(app.element(id).children.length, 0, id);
      assert.equal(
        app.element("resources").children.some((node) => node.textContent.includes("私有标题")),
        false,
      );
      assert.notEqual(app.api.operationKey("create", { title: "draft" }).key, operation.key);
    } else {
      assert.match(app.element("session-state").textContent, /已登录/);
      assert.equal(app.element("new-title").value, "私有草稿");
      assert.equal(app.api.operationKey("create", { title: "draft" }).key, operation.key);
      assert.match(app.element("notice").textContent, new RegExp(code));
    }
    assert.equal(app.requests.filter(({ path }) => path.startsWith("/v1/reviews")).length, 1);
    assert.equal(
      app.requests.some(({ path }) => path === "/auth/logout"),
      false,
    );
  });
}
