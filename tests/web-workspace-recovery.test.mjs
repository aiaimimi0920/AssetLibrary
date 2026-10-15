import assert from "node:assert/strict";
import test from "node:test";
import { appFixture } from "./web-app-fixture.mjs";

for (const failure of ["resource", "uploads", "versions"]) {
  test(`切换资源的 ${failure} 读取失败后保留一致的原工作区，手动重试可恢复`, async (t) => {
    let failing = true;
    const resources = ["first", "second"].map((id) => ({
      id,
      title: id,
      kind: "art",
      owner: "owner",
      revision: 1,
      state: "draft",
    }));
    const app = await appFixture(t, (path) => {
      if (path === "/auth/session")
        return Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) });
      if (path.startsWith("/v1/me/resources")) return Response.json({ items: resources });
      const match = /^\/v1\/resources\/(first|second)(?:\/(uploads|versions))?/.exec(path);
      assert.ok(match, path);
      const [, id, part = "resource"] = match;
      if (failing && id === "second" && part === failure)
        return Response.json({ error: "TEMPORARILY_UNAVAILABLE" }, { status: 503 });
      if (part === "resource") return Response.json(resources.find((item) => item.id === id));
      return Response.json({ items: [], nextCursor: null });
    });
    async function select(index) {
      app.element("resources").children[index].listeners.get("click")();
      await app.settled();
    }
    await select(0);
    assert.match(app.element("resource-state").textContent, /first/);
    await select(1);
    assert.match(app.element("notice").textContent, /503/);
    assert.match(app.element("resource-state").textContent, /first/);
    assert.equal(app.element("upload-form").querySelector().disabled, false);
    const before = app.requests.length;
    await app.click("refresh-workspace");
    assert.equal(app.requests[before].path, "/v1/resources/first");
    failing = false;
    await select(1);
    assert.match(app.element("resource-state").textContent, /second/);
    assert.equal(app.element("resource-title").value, "second");
  });
}

test("创建已成功但目录刷新失败时，显示新资源而非保留旧工作区", async (t) => {
  let created = false;
  const old = { id: "old", title: "旧资源", kind: "art", owner: "owner", revision: 1 };
  const next = { ...old, id: "new", title: "新资源" };
  const app = await appFixture(t, (path, options) => {
    if (path === "/auth/session")
      return Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) });
    if (path === "/v1/resources" && options.method === "POST") {
      created = true;
      return Response.json(next, { status: 201 });
    }
    if (path.startsWith("/v1/me/resources"))
      return created
        ? Response.json({ error: "TEMPORARILY_UNAVAILABLE" }, { status: 503 })
        : Response.json({ items: [old] });
    if (path === "/v1/resources/old") return Response.json(old);
    return Response.json({ items: [], nextCursor: null });
  });
  app.element("resources").children[0].listeners.get("click")();
  await app.settled();
  app.element("new-title").value = next.title;
  app.element("new-kind").value = next.kind;
  app.element("create-form").listeners.get("submit")({ preventDefault() {} });
  await app.settled();
  assert.match(app.element("notice").textContent, /503/);
  assert.match(app.element("notice").textContent, /资源已创建/);
  assert.match(app.element("resource-state").textContent, /新资源/);
  assert.equal(app.element("new-title").value, "");
  assert.equal(app.element("resource-title").value, next.title);
  assert.equal(app.requests.filter(({ path }) => path === "/v1/resources").length, 1);
});
