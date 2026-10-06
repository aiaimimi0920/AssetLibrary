import assert from "node:assert/strict";
import test from "node:test";
import { reviewQueue } from "../src/web/render.client.js";

test("审核待办只用文本节点，绑定变更提示与按 ID 读取动作保持，空/错误/清除不残留旧数据", () => {
  const previous = globalThis.document;
  const nodes = new Map();
  function node() {
    return {
      children: [],
      dataset: {},
      listeners: {},
      textContent: "",
      append(...values) {
        this.children.push(...values);
      },
      replaceChildren() {
        this.children = [];
      },
      addEventListener(name, listener) {
        this.listeners[name] = listener;
      },
    };
  }
  try {
    globalThis.document = {
      createElement: node,
      getElementById(id) {
        if (!nodes.has(id)) nodes.set(id, node());
        return nodes.get(id);
      },
    };
    let selected;
    const state = {
      reviewStatus: "本页 1 项待办",
      reviews: [
        {
          id: "version-id",
          owner: "user:publisher",
          label: "v1",
          bindingCurrent: false,
          snapshot: { title: "<img src=x onerror=alert(1)>" },
        },
      ],
    };
    reviewQueue(state, (id) => {
      selected = id;
    });
    const row = nodes.get("reviews").children[0];
    assert.equal(row.children[0].textContent, "<img src=x onerror=alert(1)> · v1");
    assert.match(row.children[2].textContent, /不能批准/);
    row.children[3].listeners.click();
    assert.equal(selected, "version-id");
    for (const message of ["读取失败：404 NOT_FOUND", "当前没有待办", "尚未读取审核待办。"]) {
      reviewQueue({ reviews: [], reviewStatus: message }, () => {});
      assert.equal(nodes.get("reviews").children.length, 0);
      assert.equal(nodes.get("reviews-state").textContent, message);
    }
  } finally {
    if (previous === undefined) delete globalThis.document;
    else globalThis.document = previous;
  }
});
