import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { dataModule } from "./web-client-fixture.mjs";

test("工作区重绘保留同资源上传选择；取消、切换资源和清除身份不复用旧选择", async (t) => {
  const original = globalThis.document;
  t.after(() => {
    globalThis.document = original;
  });
  const nodes = new Map();
  function node(select = false) {
    let selected = "";
    return {
      dataset: {},
      children: [],
      textContent: "",
      get value() {
        return selected;
      },
      set value(value) {
        selected = select && !this.children.some((item) => item.value === value) ? "" : value;
      },
      replaceChildren() {
        this.children = [];
        selected = "";
      },
      append(...items) {
        const empty = !this.children.length;
        this.children.push(...items);
        if (select && empty) selected = items[0]?.value ?? "";
      },
      addEventListener() {},
    };
  }
  globalThis.document = {
    createElement: () => node(),
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node(id === "version-upload"));
      return nodes.get(id);
    },
  };
  const source = await readFile(new URL("../src/web/render.client.js", import.meta.url), "utf8");
  const { workspace } = await import(dataModule(source));
  const state = {
    principal: "owner",
    resource: { id: "one", owner: "owner" },
    uploads: ["old", "new"].map((id) => ({ id, state: "quarantined" })),
    versions: [],
    inspections: {},
  };
  workspace(state, {});
  const select = nodes.get("version-upload");
  select.value = "new";
  state.inspections.new = { state: "passed" };
  workspace(state, {});
  assert.equal(select.value, "new", "查询检查不得将新版选择退回旧版");
  state.uploads.reverse();
  workspace(state, {});
  assert.equal(select.value, "new", "刷新和排序变化保留当前选择");
  state.uploads[0].state = "cancelled";
  workspace(state, {});
  assert.equal(select.value, "", "取消当前上传不得静默绑定另一个包");
  workspace(state, {});
  assert.equal(select.value, "", "重复重绘不能恢复默认旧包");
  state.resource = { id: "two", owner: "owner" };
  workspace(state, {});
  assert.equal(select.value, "old", "新资源按其自己的候选初始化");
  state.resource = null;
  workspace(state, {});
  assert.equal(select.value, "");
  assert.equal(select.children.length, 0);
});
