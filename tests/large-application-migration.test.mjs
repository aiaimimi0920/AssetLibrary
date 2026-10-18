import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture } from "./fixture.mjs";

test("大包 schema 只扩展新应用策略，旧策略和未扫描事实约束保持", async () => {
  const f = await fixture();
  try {
    await f.db
      .prepare(`INSERT INTO resources VALUES
      ('large-resource', 'user:alice', 'application', 'Large app', 'draft', 1, 'now', 'now')`)
      .run();
    const digest = "a".repeat(64);
    await f.db
      .prepare(`INSERT INTO uploads VALUES
      ('large-upload', 'large-resource', 'user:alice', 80423635, ?, 'quarantined', 2,
      'etag', 1, 1, 1, 1, 'upload-op')`)
      .bind(digest)
      .run();
    await f.db
      .prepare(`INSERT INTO inspections VALUES
      ('large-inspection', 'large-upload', 'application-large-zip-format-v1', 2,
      80423635, ?, 'etag', 'queued', 1, 0, NULL, 0, 0, NULL, NULL, 1, 1, 'inspect-op')`)
      .bind(digest)
      .run();
    for (const policy of ["application-zip-format-v1", "application-zip-clamav-v1"]) {
      await assert.rejects(f.db.prepare("UPDATE inspections SET policy = ?").bind(policy).run());
    }
    await assert.rejects(f.db.prepare("UPDATE uploads SET expected_size = 96000001").run());
    await assert.rejects(f.db.prepare("UPDATE inspections SET expected_size = 96000001").run());
    const result = {
      schema: "neuro-software-package-v1",
      kind: "application",
      scanStatus: "not_scanned",
      sha256: digest,
    };
    for (const invalid of [
      { ...result, kind: "art" },
      { ...result, schema: "other" },
      { ...result, scanStatus: "clean" },
      { ...result, scan: { verdict: "clean" } },
      { ...result, sha256: "b".repeat(64) },
    ]) {
      await assert.rejects(
        f.db
          .prepare("UPDATE inspections SET state = 'passed', result = ?")
          .bind(JSON.stringify(invalid))
          .run(),
      );
    }
    await f.db
      .prepare("UPDATE inspections SET state = 'passed', result = ?")
      .bind(JSON.stringify(result))
      .run();
    await f.db
      .prepare(`INSERT INTO versions VALUES
      ('large-version', 'large-resource', '1.0.0', 1, 'Large app', 'application',
      'large-upload', 2, 80423635, ?, 'etag', 'large-inspection', 1,
      'application-large-zip-format-v1', 'pending_review', 1, NULL, NULL, NULL, NULL,
      1, 1, 'version-op')`)
      .bind(digest)
      .run();
    await assert.rejects(f.db.prepare("UPDATE versions SET kind = 'art'").run());
    await assert.rejects(
      f.db.prepare("UPDATE versions SET inspection_policy = 'application-zip-format-v1'").run(),
    );
    await assert.rejects(f.db.prepare("UPDATE versions SET expected_size = 96000001").run());
    assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  } finally {
    await f.dispose();
  }
});
