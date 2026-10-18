import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { workspace } from "../src/web/render.client.js";

test("发布界面展示真实阻断，不将已开放分发写成未准入", async (t) => {
  const original = globalThis.document;
  t.after(() => {
    globalThis.document = original;
  });
  const nodes = new Map();
  const node = () => ({
    dataset: {},
    children: [],
    textContent: "",
    append(...items) {
      this.children.push(...items);
    },
    replaceChildren() {
      this.children = [];
    },
    addEventListener(_, handler) {
      this.click = handler;
    },
  });
  globalThis.document = {
    createElement: node,
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, node());
      return nodes.get(id);
    },
  };
  const version = { id: "v1", state: "approved", publicationBlockers: [] };
  const state = {
    principal: "owner",
    resource: { id: "r1", owner: "owner" },
    uploads: [],
    versions: [version],
  };
  let published;
  workspace(state, { publish: (value) => (published = value) });
  const row = nodes.get("versions").children[0];
  assert.equal(row.children[2].textContent, "无发布阻断");
  const button = row.children[3].children.find((item) => item.textContent === "请求发布");
  button.click();
  assert.equal(published, version);
  version.publicationBlockers = ["VERSION_BINDING_NOT_READY"];
  workspace(state, {});
  assert.equal(
    nodes.get("versions").children[0].children[2].textContent,
    "当前发布阻断：VERSION_BINDING_NOT_READY",
  );
  const html = await readFile(new URL("../src/web/index.html", import.meta.url), "utf8");
  assert.match(html, /Art、Capability、MCP/);
  assert.match(html, /业务包未进行病毒扫描/);
  assert.doesNotMatch(html, /尚未开放生产发布或下载|生产尚未准入/);
});
