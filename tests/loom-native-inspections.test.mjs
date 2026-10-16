import assert from "node:assert/strict";
import { test } from "node:test";
import { artZip } from "../scripts/art-package-zip.mjs";
import { startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { prepared, read } from "./inspection-fixture.mjs";
import { cleanFact, jsonFact, runScanner } from "./scanner-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

for (const kind of ["art", "capability"]) {
  test(`Loom ${kind} 原生包走真实 D1/R2 和独立审核，原字节扫描，生产发布保持拒绝`, async () => {
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
          : [{ path: "capability.manifest.json", bytes: Buffer.from('{"kind":"capability"}') }];
      const bytes = artZip(
        [{ path: "runtime/main.exe", bytes: Buffer.from("fixture only, never run") }, ...markers],
        8,
      );
      const upload = await prepared(f, bytes, kind);
      const policy = `loom-${kind}-zip-clamav-v1`;
      const queued = await startPackage(f, upload, policy);
      assert.equal(queued.status, 201, JSON.stringify(queued.body));
      let calls = 0;
      await runScanner(f, {
        async fetch(request) {
          calls++;
          assert.deepEqual(Buffer.from(await request.arrayBuffer()), bytes);
          return jsonFact(cleanFact(upload));
        },
      });
      assert.equal(calls, 1);
      const checked = (await read(f, upload)).body;
      assert.equal(checked.state, "passed", JSON.stringify(checked));
      assert.equal(checked.result.schema, "loom-native-zip-v1");
      assert.equal(checked.result.kind, kind);
      assert.equal(checked.publicationEligible, false);
      const created = await createVersion(f, upload);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const approved = await review(f, created.body);
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      const published = await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
        revision: approved.body.revision,
      });
      assert.equal(published.status, 409);
      assert.equal(published.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
      // D1 独立阻止伪造新策略的 passed 结果，不接受旧封装或缺失 AV。
      const row = await f.db
        .prepare("SELECT id, result FROM inspections WHERE upload_id = ?")
        .bind(upload.id)
        .first();
      assert.ok(row);
      for (const result of [
        { ...checked.result, schema: "neuro-software-package-v1" },
        { ...checked.result, scan: null },
      ])
        await assert.rejects(
          f.db
            .prepare("UPDATE inspections SET result = ? WHERE id = ?")
            .bind(JSON.stringify(result), row.id)
            .run(),
        );
    } finally {
      await f.dispose();
    }
  });
}
