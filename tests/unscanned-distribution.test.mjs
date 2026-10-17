import assert from "node:assert/strict";
import { test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { softwareBytes } from "./software-package-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

for (const [kind, policy] of [
  ["art", "loom-art-zip-format-v1"],
  ["capability", "loom-capability-zip-format-v1"],
  ["capability", "capability-zip-format-v1"],
  ["application", "application-zip-format-v1"],
  ["mcp", "mcp-zip-format-v1"],
  ["mcp", "loom-mcp-zip-format-v1"],
]) {
  test(`${policy} 经真实 Worker 发布并由不同主体下载；撤销旧票据失效`, async () => {
    const f = await fixture({ reviewers: reviewerConfig });
    try {
      const markers =
        kind === "art"
          ? [
              {
                path: "manifest.json",
                bytes: Buffer.from('{"execution":{"type":"framework_art"}}'),
              },
              {
                path: "art.runtime.json",
                bytes: Buffer.from('{"protocolVersion":"loom.art.runtime.v1"}'),
              },
            ]
          : kind === "mcp"
            ? [
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
              ]
            : [{ path: "capability.manifest.json", bytes: Buffer.from('{"kind":"capability"}') }];
      const bytes = policy.startsWith("loom-")
        ? artZip(
            [...markers, { path: "runtime/main.py", bytes: Buffer.from("print('fixture')") }],
            8,
          )
        : softwareBytes(kind);
      const upload = await prepared(f, bytes, kind);
      assert.equal((await startPackage(f, upload, policy)).status, 201);
      let scanCalls = 0;
      await runScanner(f, {
        fetch() {
          scanCalls++;
          throw new Error("SCANNER_MUST_NOT_RUN");
        },
      });
      assert.equal(scanCalls, 0);
      const checked = (await read(f, upload)).body;
      assert.equal(checked.state, "passed", JSON.stringify(checked));
      assert.equal(checked.result.scanStatus, "not_scanned");
      assert.equal(Object.hasOwn(checked.result, "scan"), false);
      const created = await createVersion(f, upload);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      assert.equal(
        (
          await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
            revision: created.body.revision,
          })
        ).status,
        409,
      );
      const approved = await review(f, created.body);
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.contentSafety.cloudValidated, false);
      assert.equal(approved.body.publicationEligible, true);
      const published = await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
        revision: approved.body.revision,
      });
      assert.equal(published.status, 201, JSON.stringify(published.body));
      assert.equal(published.body.scanStatus, "not_scanned");
      const id = published.body.id;
      const catalog = await f.request("GET", "/v1/catalog", undefined, { token: null });
      assert.equal(catalog.status, 200);
      assert.ok(catalog.body.items.some((item) => item.id === id));
      const bob = { principal: "user:bob" };
      assert.equal(
        (await f.request("POST", `/v1/publications/${id}/tickets`, {}, bob)).status,
        404,
      );
      const granted = await f.request("PUT", `/v1/publications/${id}/grants/user:bob`, {
        revision: 0,
      });
      assert.equal(granted.status, 200, JSON.stringify(granted.body));
      const ticket = await f.request("POST", `/v1/publications/${id}/tickets`, {}, bob);
      assert.equal(ticket.status, 201, JSON.stringify(ticket.body));
      const headers = {
        authorization: `Bearer ${await f.token("user:bob")}`,
        "x-download-ticket": ticket.body.ticket,
      };
      const download = await f.mf.dispatchFetch(`http://localhost/v1/publications/${id}/content`, {
        headers,
      });
      assert.equal(download.status, 200);
      assert.deepEqual(Buffer.from(await download.arrayBuffer()), bytes);
      assert.equal(
        (
          await f.request("DELETE", `/v1/publications/${id}/grants/user:bob`, {
            revision: granted.body.revision,
          })
        ).status,
        200,
      );
      const denied = await f.mf.dispatchFetch(`http://localhost/v1/publications/${id}/content`, {
        headers,
      });
      assert.equal(denied.status, 404);
      await denied.arrayBuffer();
      const row = await f.db
        .prepare("SELECT id FROM inspections WHERE upload_id = ?")
        .bind(upload.id)
        .first();
      for (const change of [
        { scanStatus: "clean" },
        { scan: { verdict: "clean" } },
        { schema: "invalid" },
      ])
        await assert.rejects(
          f.db
            .prepare("UPDATE inspections SET result = ? WHERE id = ?")
            .bind(JSON.stringify({ ...checked.result, ...change }), row.id)
            .run(),
        );
    } finally {
      await f.dispose();
    }
  });
}
