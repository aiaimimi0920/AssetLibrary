import assert from "node:assert/strict";
import test from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared } from "./inspection-fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { softwareBytes } from "./software-package-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

function nativeBytes(kind) {
  const markers =
    kind === "art"
      ? [
          { path: "manifest.json", bytes: Buffer.from('{"execution":{"type":"framework_art"}}') },
          {
            path: "art.runtime.json",
            bytes: Buffer.from('{"protocolVersion":"loom.art.runtime.v1"}'),
          },
        ]
      : kind === "capability"
        ? [{ path: "capability.manifest.json", bytes: Buffer.from('{"kind":"capability"}') }]
        : [
            {
              path: "mcp.server.json",
              bytes: Buffer.from(
                JSON.stringify({
                  schemaVersion: 1,
                  id: "echo",
                  version: "1.0.0",
                  publisher: { id: "example" },
                  transport: "stdio",
                  entry: { command: "runtime/main.py" },
                }),
              ),
            },
          ];
  return artZip(
    [...markers, { path: "runtime/main.py", bytes: Buffer.from("fixture only, never run") }],
    8,
  );
}

async function publish(f, kind, title, policy, bytes) {
  const upload = await prepared(f, bytes, kind);
  assert.equal(
    (await f.request("PATCH", `/v1/resources/${upload.resourceId}`, { title, revision: 1 })).status,
    200,
  );
  assert.equal((await startPackage(f, upload, policy)).status, 201);
  await runScanner(f, {
    fetch() {
      throw new Error("SCANNER_MUST_NOT_RUN");
    },
  });
  const version = await createVersion(f, upload);
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const approved = await review(f, version.body);
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const published = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
    revision: approved.body.revision,
  });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  return published.body;
}

test("Trove 分区按真实包合同过滤，字面搜索和私库权限不降级", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const app = await publish(
      f,
      "application",
      "Color App",
      "application-zip-format-v1",
      softwareBytes("application"),
    );
    const capability = await publish(
      f,
      "capability",
      "Loom 普通能力",
      "capability-zip-format-v1",
      softwareBytes("capability"),
    );
    const asset = await publish(f, "art", "Loom 100%_素材", "art-zip-manifest-v1", packageBytes());
    const native = [];
    for (const kind of ["art", "capability", "mcp"])
      native.push(
        await publish(
          f,
          kind,
          `Color Native ${kind}`,
          `loom-${kind}-zip-format-v1`,
          nativeBytes(kind),
        ),
      );
    const catalog = (query) => f.request("GET", `/v1/catalog?${query}`, undefined, { token: null });
    const ids = (page) => page.body.items.map((item) => item.id).sort();
    assert.deepEqual(ids(await catalog("section=applications")), [app.id]);
    assert.deepEqual(ids(await catalog("section=assets")), [asset.id]);
    assert.deepEqual(ids(await catalog("section=loom")), native.map((item) => item.id).sort());
    assert.deepEqual(ids(await catalog("section=loom&kind=mcp&q=COLOR")), [native[2].id]);
    assert.deepEqual(ids(await catalog("section=assets&q=100%25_")), [asset.id]);
    assert.deepEqual(ids(await catalog("section=assets&kind=application")), []);
    assert.deepEqual(ids(await catalog(`section=loom&q=${encodeURIComponent("' OR 1=1 --")}`)), []);
    assert.ok(
      ids(await catalog("kind=capability")).includes(capability.id),
      "泛用能力仍可从全部目录找到",
    );
    for (const query of [
      "section=",
      "section=games",
      "section=__proto__",
      "section=loom&section=loom",
      `section=${encodeURIComponent("' OR 1=1 --")}`,
    ]) {
      const invalid = await catalog(query);
      assert.equal(invalid.status, 400, query);
      assert.equal(invalid.body.error, "INVALID_CATALOG_FILTER");
    }
    assert.equal(
      (await f.request("GET", "/v1/me/library?section=loom", undefined, { token: null })).status,
      401,
    );
    const bob = { principal: "user:bob" };
    assert.deepEqual(
      ids(await f.request("GET", "/v1/me/library?section=loom", undefined, bob)),
      [],
    );
    assert.equal(
      (await f.request("PUT", `/v1/publications/${native[0].id}/grants/user:bob`, { revision: 0 }))
        .status,
      200,
    );
    assert.deepEqual(ids(await f.request("GET", "/v1/me/library?section=loom", undefined, bob)), [
      native[0].id,
    ]);
    assert.deepEqual(
      ids(await f.request("GET", "/v1/me/library?section=assets", undefined, bob)),
      [],
    );
    // 分区过滤不改变失效候选的扫描预算和手动游标。
    const sorted = [...native].sort((a, b) => a.id.localeCompare(b.id));
    await f.db
      .prepare("UPDATE versions SET revision = revision + 1 WHERE id = ?")
      .bind(sorted[0].versionId)
      .run();
    const first = await catalog("section=loom&limit=1");
    assert.deepEqual(ids(first), []);
    assert.equal(first.body.nextAfter, sorted[0].id);
    const next = await catalog(`section=loom&limit=1&after=${first.body.nextAfter}`);
    assert.deepEqual(ids(next), [sorted[1].id]);
  } finally {
    await f.dispose();
  }
});
