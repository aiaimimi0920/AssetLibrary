import assert from "node:assert/strict";
import test from "node:test";
import { clearView, restoreFocus } from "../src/web/render.client.js";

test("请求结束重新启用控件后恢复丢失焦点，不抢用户焦点或聚焦已移除控件", () => {
  const original = globalThis.document;
  const body = {};
  let calls = 0;
  const previous = { isConnected: true, disabled: true, focus: () => calls++ };
  try {
    globalThis.document = { body, activeElement: body };
    restoreFocus(previous);
    assert.equal(calls, 0);
    previous.disabled = false;
    restoreFocus(previous);
    assert.equal(calls, 1);
    globalThis.document.activeElement = {};
    restoreFocus(previous);
    assert.equal(calls, 1);
    globalThis.document.activeElement = { closest: () => ({ open: false }) };
    restoreFocus(previous);
    assert.equal(calls, 2);
    globalThis.document.activeElement = { closest: () => ({ open: true }) };
    restoreFocus(previous);
    assert.equal(calls, 2);
    globalThis.document.activeElement = body;
    previous.isConnected = false;
    restoreFocus(previous);
    restoreFocus(null);
    assert.equal(calls, 2);
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});

test("清除身份时不保留上一主体的资源标题草稿", () => {
  const original = globalThis.document;
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id))
      nodes.set(id, { value: "", textContent: "", replaceChildren() {}, append() {} });
    return nodes.get(id);
  };
  try {
    globalThis.document = { getElementById: node, createElement: () => ({}) };
    node("new-title").value = "上一主体的私有标题";
    clearView({
      principal: "",
      resources: [],
      resource: null,
      reviews: [],
      reviewStatus: "",
      uploads: [],
      versions: [],
    });
    assert.equal(node("new-title").value, "");
  } finally {
    if (original === undefined) delete globalThis.document;
    else globalThis.document = original;
  }
});
