import assert from "node:assert/strict";
import test from "node:test";
import { fixture } from "./fixture.mjs";
import { readyVersion, review, reviewerConfig } from "./version-fixture.mjs";

test("公开 Web 静态模块无凭据可读，业务身份仍拒绝伪造与缺失配置", async () => {
  const f = await fixture();
  try {
    for (const [url, type] of [
      ["/", "text/html"],
      ["/style.css", "text/css"],
      ...[
        "app",
        "api",
        "render",
        "upload",
        "distribution",
        "distribution-render",
        "download",
        "resume-download",
        "resource",
      ].map((name) => [`/${name}.client.js`, "text/javascript"]),
    ]) {
      const response = await f.mf.dispatchFetch(`http://localhost${url}`);
      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), new RegExp(type));
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.match(response.headers.get("content-security-policy"), /frame-ancestors 'none'/);
      assert.match(response.headers.get("content-security-policy"), /connect-src 'self'/);
      const content = await response.text();
      assert.ok(content.length > 100);
      if (url === "/") {
        // HTML pattern 使用 Unicode sets (v)；连字符必须转义，不能因语法错误失去表单校验。
        const pattern = content.match(/pattern="([^"]+)"/)?.[1];
        assert.ok(pattern);
        const label = new RegExp(`^(?:${pattern})$`, "v");
        assert.ok(label.test("v1.0-beta_1"));
        assert.equal(label.test("v1<invalid>"), false);
      }
      if (url === "/style.css")
        assert.match(content, /body:has\(dialog\[open\]\)\s*\{\s*overflow: hidden;/);
    }
    assert.equal((await f.mf.dispatchFetch("http://localhost/", { method: "HEAD" })).status, 200);
    assert.equal((await f.request("GET", "/v1/me", undefined, { token: null })).status, 401);
    const identity = await f.request("GET", "/v1/me");
    assert.deepEqual(identity.body, { principal: "user:alice" });
    assert.deepEqual(
      (await f.request("GET", "/v1/me", undefined, { principal: "user:bob" })).body,
      { principal: "user:bob" },
    );
  } finally {
    await f.dispose();
  }
  const unavailable = await fixture({ identity: false });
  try {
    assert.equal((await unavailable.mf.dispatchFetch("http://localhost/")).status, 200);
    assert.equal((await unavailable.request("GET", "/v1/me")).status, 503);
  } finally {
    await unavailable.dispose();
  }
});

test("owner 上传与版本工作列表读取真实状态，分页有界，成员和 reviewer 不得到管理目录", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const first = await readyVersion(f);
    const resourceId = first.upload.resourceId;
    const second = await f.request("POST", `/v1/resources/${resourceId}/uploads`, {
      size: 1,
      sha256: "a".repeat(64),
    });
    assert.equal(second.status, 201);
    const url = `/v1/resources/${resourceId}/uploads`;
    const page = await f.request("GET", `${url}?limit=1`);
    assert.equal(page.body.items.length, 1);
    assert.ok(page.body.nextCursor);
    const next = await f.request("GET", `${url}?limit=1&after=${page.body.nextCursor}`);
    assert.equal(next.body.items.length, 1);
    assert.notEqual(page.body.items[0].id, next.body.items[0].id);
    assert.equal(next.body.nextCursor, null);
    const approved = await review(f, first.version);
    assert.equal(approved.status, 200);
    const versions = await f.request("GET", `/v1/resources/${resourceId}/versions`);
    assert.equal(versions.body.items[0].state, "approved");
    assert.equal(versions.body.items[0].publicationEligible, false);
    for (const suffix of ["uploads", "versions"]) {
      for (const query of ["limit=0", "limit=51", "after=x", "limit=1&limit=2", "unknown=x"])
        assert.equal(
          (await f.request("GET", `/v1/resources/${resourceId}/${suffix}?${query}`)).status,
          400,
        );
      for (const principal of ["user:bob", "user:reviewer"])
        assert.equal(
          (
            await f.request("GET", `/v1/resources/${resourceId}/${suffix}`, undefined, {
              principal,
            })
          ).status,
          404,
        );
    }
    assert.equal(
      (await f.request("PUT", `/v1/resources/${resourceId}/members/user:bob`, { revision: 1 }))
        .status,
      200,
    );
    for (const suffix of ["uploads", "versions"])
      assert.equal(
        (
          await f.request("GET", `/v1/resources/${resourceId}/${suffix}`, undefined, {
            principal: "user:bob",
          })
        ).status,
        404,
      );
    const current = await f.request("GET", `/v1/resources/${resourceId}/versions`);
    assert.equal(current.body.items[0].bindingCurrent, false);
    assert.equal(
      (await f.request("DELETE", `/v1/resources/${resourceId}`, { revision: 2 })).status,
      200,
    );
    for (const suffix of ["uploads", "versions"])
      assert.equal((await f.request("GET", `/v1/resources/${resourceId}/${suffix}`)).status, 404);
  } finally {
    await f.dispose();
  }
});
