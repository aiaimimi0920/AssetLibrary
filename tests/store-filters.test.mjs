import assert from "node:assert/strict";
import test from "node:test";
import { startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared } from "./inspection-fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { softwareBytes } from "./software-package-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

test("商店匿名筛选、字面搜索、有界分页和私库权限复用真实 Worker/D1", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const items = [];
    for (const [kind, title] of [
      ["capability", "Color 100%_Tool"],
      ["capability", "Color Other"],
      ["application", "Color App"],
    ]) {
      const upload = await prepared(f, softwareBytes(kind), kind);
      assert.equal(
        (await f.request("PATCH", `/v1/resources/${upload.resourceId}`, { title, revision: 1 }))
          .status,
        200,
      );
      assert.equal((await startPackage(f, upload, `${kind}-zip-format-v1`)).status, 201);
      await runScanner(f, {
        fetch() {
          throw new Error("SCANNER_MUST_NOT_RUN");
        },
      });
      const version = await createVersion(f, upload);
      assert.equal(version.status, 201, JSON.stringify(version.body));
      const approved = await review(f, version.body);
      const published = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
        revision: approved.body.revision,
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      items.push(published.body);
    }
    const anonymous = (query) =>
      f.request("GET", `/v1/catalog?${query}`, undefined, { token: null });
    const page = await anonymous("kind=capability&q=COLOR&limit=1");
    assert.equal(page.status, 200);
    assert.equal(page.body.items.length, 1);
    assert.ok(page.body.nextAfter);
    const next = await anonymous(`kind=capability&q=color&limit=1&after=${page.body.nextAfter}`);
    assert.equal(next.body.items.length, 1);
    assert.notEqual(next.body.items[0].id, page.body.items[0].id);
    assert.equal(next.body.nextAfter, null);
    assert.deepEqual(
      (await anonymous("q=100%25_")).body.items.map((item) => item.title),
      ["Color 100%_Tool"],
    );
    assert.deepEqual((await anonymous(`q=${encodeURIComponent("' OR 1=1 --")}`)).body.items, []);
    assert.equal(
      (await f.request("GET", "/v1/me/library?kind=capability", undefined, { token: null })).status,
      401,
    );
    const bob = { principal: "user:bob" };
    assert.deepEqual(
      (await f.request("GET", "/v1/me/library?q=Color", undefined, bob)).body.items,
      [],
    );
    assert.equal(
      (await f.request("PUT", `/v1/publications/${items[0].id}/grants/user:bob`, { revision: 0 }))
        .status,
      200,
    );
    const library = await f.request(
      "GET",
      "/v1/me/library?kind=capability&q=100%25_",
      undefined,
      bob,
    );
    assert.deepEqual(
      library.body.items.map((item) => item.id),
      [items[0].id],
    );
    for (const query of [
      "kind=bad",
      "kind=art&kind=art",
      "q=",
      "q=%20",
      "q=a&q=b",
      `q=${"a".repeat(101)}`,
      "limit=51",
      "sort=title",
    ]) {
      assert.equal((await anonymous(query)).status, 400, query);
    }
    // 失效候选占扫描预算，不能因当前页为空而丢失后续有效项。
    const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id));
    await f.db
      .prepare("UPDATE versions SET revision = revision + 1 WHERE id = ?")
      .bind(sorted[0].versionId)
      .run();
    const invalid = await anonymous("q=Color&limit=1");
    assert.deepEqual(invalid.body.items, []);
    assert.equal(invalid.body.nextAfter, sorted[0].id);
    assert.equal(
      (await anonymous(`q=Color&limit=1&after=${invalid.body.nextAfter}`)).body.items.length,
      1,
    );
  } finally {
    await f.dispose();
  }
});
