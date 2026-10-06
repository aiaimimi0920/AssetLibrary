import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { distributionUi } from "./web-distribution-fixture.mjs";

test("修改授权主体或发布 ID 必须重新查询，不向旧 principal/revision 提交", async () => {
  const original = globalThis.fetch;
  const ui = await distributionUi();
  const id = randomUUID();
  const calls = [];
  try {
    ui.api.setCredential("synthetic");
    globalThis.fetch = async (path, options) => {
      calls.push({ path, method: options.method, body: options.body });
      if (!path.includes("/grants/")) return Response.json({ id, state: "published", revision: 1 });
      if (options.method === "GET") return Response.json({ error: "NOT_FOUND" }, { status: 404 });
      return Response.json({ principal: "user:bob", state: "active", revision: 1 });
    };
    ui.nodes["publication-id"].value = id;
    await ui.tasks.get("publication-read-form")();
    ui.nodes["grant-principal"].value = "user:bob";
    await ui.tasks.get("grant-read-form")();
    assert.equal(ui.nodes["grant-activate"].disabled, false);
    ui.nodes["grant-principal"].input("user:eve");
    assert.equal(ui.nodes["grant-activate"].disabled, true);
    await assert.rejects(ui.tasks.get("grant-activate")(), /READ_DOWNLOAD_GRANT_REQUIRED/);
    assert.ok(calls.every((request) => request.method !== "PUT"));
    ui.nodes["grant-principal"].value = "user:bob";
    await ui.tasks.get("grant-read-form")();
    await ui.tasks.get("grant-activate")();
    assert.equal(
      calls.at(-1).path,
      `/v1/publications/${id}/grants/${encodeURIComponent("user:bob")}`,
    );
    assert.deepEqual(JSON.parse(calls.at(-1).body), { revision: 0 });
    ui.nodes["publication-id"].input(randomUUID());
    assert.equal(ui.nodes["unlist-publication"].disabled, true);
    assert.equal(ui.nodes["grant-principal"].disabled, true);
  } finally {
    ui.api.stopRequests();
    globalThis.fetch = original;
    delete globalThis.__distributionNodes;
  }
});

test("授权未知提交禁用再次操作，恢复须读取当前事实而非猜 revision", async () => {
  const original = globalThis.fetch;
  const ui = await distributionUi();
  const id = randomUUID();
  try {
    ui.api.setCredential("synthetic");
    globalThis.fetch = async (path, options) =>
      !path.includes("/grants/")
        ? Response.json({ id, state: "published", revision: 1 })
        : options.method === "GET"
          ? Response.json({ principal: "user:bob", state: "revoked", revision: 2 })
          : Response.json({ error: "SERVICE_UNAVAILABLE" }, { status: 503 });
    ui.nodes["publication-id"].value = id;
    await ui.tasks.get("publication-read-form")();
    ui.nodes["grant-principal"].value = "user:bob";
    await ui.tasks.get("grant-read-form")();
    await assert.rejects(ui.tasks.get("grant-activate")(), /SERVICE_UNAVAILABLE/);
    assert.equal(ui.nodes["grant-activate"].disabled, true);
    assert.equal(ui.nodes["grant-revoke"].disabled, true);
    assert.match(ui.nodes["grant-detail"].textContent, /先查询/);
    await ui.tasks.get("grant-read-form")();
    assert.equal(ui.nodes["grant-activate"].disabled, false);
    assert.match(ui.nodes["grant-detail"].textContent, /"revision":2/);
  } finally {
    ui.api.stopRequests();
    globalThis.fetch = original;
    delete globalThis.__distributionNodes;
  }
});

test("门禁不可用不是空目录；身份清除后的旧错误不得污染新视图", async () => {
  const original = globalThis.fetch;
  const ui = await distributionUi();
  try {
    globalThis.fetch = async () =>
      Response.json({ error: "SCANNER_CLOUD_NOT_VALIDATED" }, { status: 503 });
    await assert.rejects(ui.tasks.get("refresh-catalog")(), /SCANNER_CLOUD_NOT_VALIDATED/);
    assert.match(ui.nodes["catalog-state"].textContent, /读取失败/);
    assert.doesNotMatch(ui.nodes["catalog-state"].textContent, /没有当前可分发记录/);
    let release;
    globalThis.fetch = async () =>
      new Promise((resolve) => {
        release = resolve;
      });
    const assertion = assert.rejects(ui.tasks.get("refresh-catalog")(), { name: "AbortError" });
    ui.control.abort();
    ui.api.setCredential("");
    ui.ui.reset();
    const reset = ui.nodes["catalog-state"].textContent;
    release(Response.json({ error: "OLD_ERROR" }, { status: 503 }));
    await assertion;
    assert.equal(ui.nodes["catalog-state"].textContent, reset);
  } finally {
    ui.api.stopRequests();
    globalThis.fetch = original;
    delete globalThis.__distributionNodes;
  }
});
