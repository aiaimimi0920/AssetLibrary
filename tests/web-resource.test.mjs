import assert from "node:assert/strict";
import test from "node:test";
import { resourceUi } from "./web-resource-fixture.mjs";

test("改名与关闭需要确认，发送当前 revision 和幂等键；取消不写入", async () => {
  const original = globalThis.fetch;
  const f = await resourceUi();
  const requests = [];
  try {
    globalThis.fetch = async (path, options) => {
      requests.push({ path, ...options });
      return Response.json({
        ...f.resource,
        title: "新标题",
        state: options.method === "DELETE" ? "deleted" : "draft",
        revision: requests.length + 3,
      });
    };
    assert.equal(f.nodes["resource-save"].disabled, true);
    f.nodes["resource-title"].input(" 新标题 ");
    f.state.confirmation = false;
    await f.tasks.get("resource-edit-form")();
    assert.equal(requests.length, 0);
    f.state.confirmation = true;
    await f.tasks.get("resource-edit-form")();
    assert.deepEqual(JSON.parse(requests[0].body), { title: "新标题", revision: 3 });
    assert.ok(requests[0].headers["Idempotency-Key"]);
    assert.match(f.state.confirmations[0][1], /既有版本绑定失效/);
    await f.tasks.get("resource-close")();
    assert.deepEqual(JSON.parse(requests[1].body), { revision: 4 });
    assert.equal(f.nodes["resource-close"].disabled, true);
    assert.equal(f.nodes["resource-title"].value, "");
  } finally {
    globalThis.fetch = original;
    delete globalThis.__resourceUi;
  }
});

test("网络失败保留同一改名意图，冲突不擅自刷新 revision 或自动重试", async () => {
  const original = globalThis.fetch;
  const f = await resourceUi();
  const keys = [];
  try {
    globalThis.fetch = async (_path, options) => {
      keys.push(options.headers["Idempotency-Key"]);
      if (keys.length === 1) throw new TypeError("connection lost");
      if (keys.length === 2) return Response.json({ error: "REVISION_CONFLICT" }, { status: 409 });
      return Response.json({ ...f.resource, title: "新标题", revision: 4 });
    };
    f.nodes["resource-title"].input("新标题");
    await assert.rejects(f.tasks.get("resource-edit-form")(), /connection lost/);
    assert.equal(keys.length, 1);
    await assert.rejects(f.tasks.get("resource-edit-form")(), /REVISION_CONFLICT/);
    assert.equal(keys[0], keys[1]);
    assert.equal(f.state.changes.length, 0);
    await f.tasks.get("resource-edit-form")();
    assert.notEqual(keys[2], keys[1]);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__resourceUi;
  }
});

test("成员写入使用查询的 revision，切换输入/资源/身份清除权限状态且非 owner 禁用", async () => {
  const original = globalThis.fetch;
  const f = await resourceUi();
  const requests = [];
  try {
    globalThis.fetch = async (path, options) => {
      requests.push({ path, ...options });
      return Response.json(
        options.method === "GET"
          ? { resourceId: f.resource.id, principal: "user:bob", active: false, resourceRevision: 5 }
          : { ...f.resource, revision: 6 },
      );
    };
    f.nodes["member-principal"].input("user:bob");
    assert.equal(f.nodes["member-grant"].disabled, true);
    await f.tasks.get("member-read-form")();
    assert.equal(f.nodes["member-grant"].disabled, false);
    await f.tasks.get("member-grant")();
    assert.deepEqual(JSON.parse(requests[1].body), { revision: 5 });
    assert.equal(f.nodes["member-grant"].disabled, true);
    f.nodes["member-principal"].input("user:other");
    await assert.rejects(f.tasks.get("member-revoke")(), /READ_DIRECTORY_MEMBER_REQUIRED/);
    f.ui.show(f.resource, "user:bob");
    f.refreshControls();
    assert.equal(f.nodes["resource-close"].disabled, true);
    await assert.rejects(f.tasks.get("resource-close")(), /SELECT_OWNED_RESOURCE_REQUIRED/);
    f.ui.reset();
    assert.equal(f.nodes["resource-title"].value, "");
    assert.equal(f.nodes["member-principal"].value, "");
  } finally {
    globalThis.fetch = original;
    delete globalThis.__resourceUi;
  }
});

test("确认期间取消或切换身份不得提交写入，迟到的成员响应不能恢复旧状态", async () => {
  const original = globalThis.fetch;
  const f = await resourceUi();
  try {
    let writes = 0;
    globalThis.fetch = async () => {
      writes++;
      return Response.json({});
    };
    let confirm;
    f.state.confirmation = new Promise((resolve) => {
      confirm = resolve;
    });
    const controller = new AbortController();
    const closing = f.tasks.get("resource-close")(controller.signal);
    controller.abort();
    f.api.setCredential("");
    f.ui.reset();
    confirm(true);
    await assert.rejects(closing, { name: "AbortError" });
    assert.equal(writes, 0);
    f.api.setCredential("test-credential");
    f.ui.show(f.resource, "user:alice");
    f.nodes["member-principal"].input("user:bob");
    let respond;
    globalThis.fetch = () =>
      new Promise((resolve) => {
        respond = resolve;
      });
    const reading = f.tasks.get("member-read-form")();
    f.api.setCredential("");
    f.ui.reset();
    respond(Response.json({ principal: "user:bob", active: true, resourceRevision: 3 }));
    await assert.rejects(reading, { name: "AbortError" });
    assert.equal(f.nodes["member-revoke"].disabled, true);
    assert.doesNotMatch(f.nodes["member-detail"].textContent, /user:bob/);
  } finally {
    globalThis.fetch = original;
    delete globalThis.__resourceUi;
  }
});
