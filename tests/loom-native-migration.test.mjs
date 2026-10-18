import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { test } from "node:test";
import { hypotheticalPublication, ticketFor } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { reviewerConfig } from "./version-fixture.mjs";

const sqlFile = (name) => readFile(new URL(`../db/${name}`, import.meta.url), "utf8");
const statements = (db, sql) =>
  sql
    .split(";")
    .filter((part) => part.trim())
    .map((part) => db.prepare(part));
async function snapshot(db) {
  const tables = (
    await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT GLOB '_cf_*' ORDER BY name",
      )
      .all()
  ).results;
  const result = {};
  for (const { name } of tables) {
    assert.match(name, /^[A-Za-z0-9_]+$/);
    result[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results
      .map((row) => JSON.stringify(row))
      .sort();
  }
  return result;
}

for (const migrationName of [
  "0009_loom_native_packages.sql",
  "0010_unscanned_packages.sql",
  "0011_mcp_packages.sql",
  "0012_large_application_packages.sql",
])
  test(`${migrationName} 保留已有发布、检查、版本、票据和审计；失败原子回滚，重复应用不改事实`, async () => {
    const f = await fixture({ schema: false, reviewers: reviewerConfig });
    try {
      const old = (await readdir(new URL("../db/", import.meta.url)))
        .filter((name) => name.endsWith(".sql") && name < migrationName)
        .sort();
      for (const name of old) await f.db.batch(statements(f.db, await sqlFile(name)));
      const { publication } = await hypotheticalPublication(f, { member: "user:bob" });
      await ticketFor(f, publication);
      const before = await snapshot(f.db);
      const migration = await sqlFile(migrationName);
      await assert.rejects(
        f.db.batch([
          ...statements(f.db, migration),
          f.db.prepare("INSERT INTO nonexistent_migration_probe VALUES (1)"),
        ]),
      );
      assert.deepEqual(await snapshot(f.db), before);
      await f.db.batch(statements(f.db, migration));
      assert.deepEqual(await snapshot(f.db), before);
      assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
      const indexes = (
        await f.db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all()
      ).results.map((row) => row.name);
      for (const name of [
        "uploads_reconcile",
        "uploads_resource",
        "inspections_due",
        "versions_resource_page",
        "versions_review_page",
      ])
        assert.ok(indexes.includes(name));
      await f.db.batch(statements(f.db, migration));
      assert.deepEqual(await snapshot(f.db), before);
    } finally {
      await f.dispose();
    }
  });
