import assert from "node:assert/strict";
import test from "node:test";
import { appFixture } from "./web-app-fixture.mjs";

for (const target of ["version", "catalog", "library"]) {
  for (const cancel of [false, true]) {
    test(`${target} 读取${cancel ? "停止" : "失败"}后不残留正在读取状态`, async (t) => {
      let requested;
      let attempts = 0;
      const started = new Promise((resolve) => {
        requested = resolve;
      });
      const app = await appFixture(t, (path, options) => {
        if (path === "/auth/session")
          return Response.json({ enabled: true, principal: "owner", csrf: "a".repeat(64) });
        if (path.startsWith("/v1/me/resources")) return Response.json({ items: [] });
        attempts += 1;
        if (attempts > 1)
          return Response.json(
            target === "version"
              ? { id: "version", state: "pending_review" }
              : { items: [], nextAfter: null },
          );
        requested();
        if (!cancel) return Response.json({ error: "TEMPORARILY_UNAVAILABLE" }, { status: 503 });
        return new Promise((_, reject) =>
          options.signal.addEventListener(
            "abort",
            () => reject(new DOMException("Aborted", "AbortError")),
            { once: true },
          ),
        );
      });
      if (target === "version") {
        app.element("review-id").value = crypto.randomUUID();
        app.element("read-version-form").listeners.get("submit")({ preventDefault() {} });
      } else app.element(`refresh-${target}`).listeners.get("click")();
      await started;
      if (cancel) app.element("stop").listeners.get("click")();
      await app.settled();
      const text = app.element(
        target === "version" ? "review-detail" : `${target}-state`,
      ).textContent;
      assert.doesNotMatch(text, /正在读取/);
      assert.match(text, cancel ? /停止/ : /503 TEMPORARILY_UNAVAILABLE/);
      assert.equal(app.element("identity-form").querySelector().disabled, false);
      assert.equal(app.api.connected(), true);
      assert.equal(attempts, 1);
      if (target === "version")
        app.element("read-version-form").listeners.get("submit")({ preventDefault() {} });
      else app.element(`refresh-${target}`).listeners.get("click")();
      await app.settled();
      assert.equal(attempts, 2);
      assert.equal(app.element("notice").dataset.tone, "success");
      assert.doesNotMatch(
        app.element(target === "version" ? "review-detail" : `${target}-state`).textContent,
        /正在读取|失败|停止/,
      );
    });
  }
}
