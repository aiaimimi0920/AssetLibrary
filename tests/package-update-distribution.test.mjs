import assert from "node:assert/strict";
import { test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { read } from "./inspection-fixture.mjs";
import { softwareBytes } from "./software-package-fixture.mjs";
import { complete, put, sha256, tick } from "./upload-fixture.mjs";
import { createVersion, creationBody, review, reviewerConfig } from "./version-fixture.mjs";

function packageBytes(kind, label) {
  const files = [{ path: "runtime/version.txt", bytes: Buffer.from(label) }];
  if (kind !== "art") return softwareBytes(kind, { files });
  return artZip([
    { path: "manifest.json", bytes: Buffer.from('{"execution":{"type":"framework_art"}}') },
    { path: "art.runtime.json", bytes: Buffer.from('{"protocolVersion":"loom.art.runtime.v1"}') },
    ...files,
  ]);
}

async function publish(f, resourceId, kind, label) {
  const bytes = packageBytes(kind, label);
  const reserved = await f.request("POST", `/v1/resources/${resourceId}/uploads`, {
    size: bytes.length,
    sha256: sha256(bytes),
  });
  assert.equal(reserved.status, 201);
  const upload = reserved.body;
  assert.equal((await put(f, upload, bytes)).status, 200);
  assert.equal((await complete(f, upload)).status, 200);
  const policy = kind === "art" ? "loom-art-zip-format-v1" : `${kind}-zip-format-v1`;
  assert.equal((await startPackage(f, upload, policy)).status, 201);
  await tick(f);
  assert.equal((await read(f, upload)).body.state, "passed");
  const version = await createVersion(f, upload, await creationBody(f, upload, { label }));
  assert.equal(version.status, 201);
  const approved = await review(f, version.body);
  assert.equal(approved.status, 200);
  const publication = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
    revision: approved.body.revision,
  });
  assert.equal(publication.status, 201);
  return { ...publication.body, bytes };
}

// 这是资源库真实 binding 的分发/更新发现验证，不冒充消费者安装和执行验收。
for (const kind of ["art", "capability", "mcp", "application"])
  test(`${kind} 同资源两版分发：更新独立授权、分页、旧票据不能读取新版`, async () => {
    const f = await fixture({ reviewers: reviewerConfig });
    try {
      const resource = await f.request("POST", "/v1/resources", { kind, title: "更新测试" });
      assert.equal(resource.status, 201);
      const id = resource.body.id;
      const first = await publish(f, id, kind, "1.0.0");
      const second = await publish(f, id, kind, "1.1.0");
      assert.notEqual(first.sha256, second.sha256);
      const bob = { principal: "user:bob" };
      const list = (suffix = "") =>
        f.request("GET", `/v1/me/library?resourceId=${id}${suffix}`, undefined, bob);
      assert.deepEqual((await list()).body.items, []);
      const grant = (publication) =>
        f.request("PUT", `/v1/publications/${publication.id}/grants/user:bob`, { revision: 0 });
      assert.equal((await grant(first)).status, 200);
      assert.deepEqual(
        (await list()).body.items.map((item) => item.label),
        ["1.0.0"],
      );
      assert.equal(
        (await f.request("POST", `/v1/publications/${second.id}/tickets`, {}, bob)).status,
        404,
      );
      assert.equal((await grant(second)).status, 200);
      const page = (await list("&limit=1")).body;
      assert.equal(page.items.length, 1);
      assert.ok(page.nextAfter);
      const next = (await list(`&limit=1&after=${page.nextAfter}`)).body;
      assert.deepEqual([...page.items, ...next.items].map((item) => item.label).sort(), [
        "1.0.0",
        "1.1.0",
      ]);
      const tickets = [];
      for (const publication of [first, second]) {
        const ticket = await f.request(
          "POST",
          `/v1/publications/${publication.id}/tickets`,
          {},
          bob,
        );
        assert.equal(ticket.status, 201);
        tickets.push(ticket.body.ticket);
        const response = await f.mf.dispatchFetch(
          `http://localhost/v1/publications/${publication.id}/content`,
          {
            headers: {
              authorization: `Bearer ${await f.token("user:bob")}`,
              "x-download-ticket": ticket.body.ticket,
            },
          },
        );
        assert.equal(response.status, 200);
        assert.deepEqual(Buffer.from(await response.arrayBuffer()), publication.bytes);
      }
      const wrong = await f.mf.dispatchFetch(
        `http://localhost/v1/publications/${second.id}/content`,
        {
          headers: {
            authorization: `Bearer ${await f.token("user:bob")}`,
            "x-download-ticket": tickets[0],
          },
        },
      );
      assert.notEqual(wrong.status, 200);
      await wrong.arrayBuffer();
      assert.equal(
        (
          await f.request("DELETE", `/v1/publications/${second.id}/grants/user:bob`, {
            revision: 1,
          })
        ).status,
        200,
      );
      assert.deepEqual(
        (await list()).body.items.map((item) => item.label),
        ["1.0.0"],
      );
      assert.equal(
        (await f.request("GET", "/v1/me/library?resourceId=bad", undefined, bob)).status,
        400,
      );
      assert.equal((await list(`&resourceId=${id}`)).status, 400);
      assert.equal(
        (await f.request("GET", `/v1/me/library?resourceId=${id}`, undefined, { token: null }))
          .status,
        401,
      );
    } finally {
      await f.dispose();
    }
  });
