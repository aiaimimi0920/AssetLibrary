import assert from "node:assert/strict";
import test from "node:test";
import { restoreFocus } from "../src/web/render.client.js";

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
