import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { hypotheticalPublication, ticketFor } from "./distribution-fixture.mjs";
import { createResource, fixture } from "./fixture.mjs";
import { prepared } from "./inspection-fixture.mjs";
import { runScanner } from "./scanner-fixture.mjs";
import { review, reviewerConfig } from "./version-fixture.mjs";

async function publishArtWithAttributes(f, title, attributes, space = "general") {
  const upload = await prepared(f, packageBytes(), "art");
  let rev = 1;
  assert.equal(
    (await f.request("PATCH", `/v1/resources/${upload.resourceId}`, { title, revision: rev }))
      .status,
    200,
  );
  rev += 1;
  if (space !== "general") {
    assert.equal(
      (
        await f.request("PUT", `/v1/resources/${upload.resourceId}/profile`, {
          revision: rev,
          space,
          summary: `${title} 摘要`,
          detail: "",
        })
      ).status,
      200,
    );
    rev += 1;
  }
  if (attributes) {
    const attrRes = await f.request("PUT", `/v1/resources/${upload.resourceId}/attributes`, {
      revision: rev,
      ...attributes,
    });
    assert.equal(attrRes.status, 200, JSON.stringify(attrRes.body));
    rev = attrRes.body.revision;
  }
  assert.equal((await startPackage(f, upload, "art-zip-manifest-v1")).status, 201);
  await runScanner(f, {
    fetch() {
      throw new Error("SCANNER_MUST_NOT_RUN");
    },
  });
  const version = await f.request("POST", `/v1/resources/${upload.resourceId}/versions`, {
    label: "1.0.0",
    uploadId: upload.id,
    resourceRevision: rev,
  });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  const approved = await review(f, version.body);
  assert.equal(approved.status, 200);
  const published = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
    revision: approved.body.revision,
  });
  assert.equal(published.status, 201);
  return {
    resourceId: upload.resourceId,
    resourceRevision: rev,
    version: version.body,
    publication: published.body,
  };
}

test("素材细分属性：输入边界、幂等审计、版本冻结与发布后修改失绑", async () => {
  const f = await fixture({ reviewers: reviewerConfig });
  try {
    const resource = await createResource(f);
    assert.deepEqual(resource.assetAttributes, {
      category: "general",
      style: "general",
      formats: [],
      license: "unspecified",
    });

    for (const invalid of [
      { revision: 1, category: "unknown", style: "pixel", formats: ["PNG"], license: "commercial" },
      { revision: 1, category: "images", style: "bad", formats: ["PNG"], license: "commercial" },
      { revision: 1, category: "images", style: "pixel", formats: ["EXE"], license: "commercial" },
      {
        revision: 1,
        category: "images",
        style: "pixel",
        formats: ["PNG", "png"],
        license: "commercial",
      },
      {
        revision: 1,
        category: "images",
        style: "pixel",
        formats: ["PNG", "SVG", "GLB", "FBX", "WAV"],
        license: "commercial",
      },
      { revision: 1, category: "images", style: "pixel", formats: ["PNG"], license: "paid" },
      {
        revision: 1,
        category: "images",
        style: "pixel",
        formats: ["PNG"],
        license: "commercial",
        extra: 1,
      },
    ]) {
      assert.equal(
        (await f.request("PUT", `/v1/resources/${resource.id}/attributes`, invalid)).status,
        400,
      );
    }

    const requestNo = "aaaaaaaa";
    const payload = {
      revision: 1,
      category: "images",
      style: "pixel",
      formats: ["svg", "PNG"],
      license: "commercial",
    };
    const saved = await f.request("PUT", `/v1/resources/${resource.id}/attributes`, payload, {
      key: requestNo,
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.revision, 2);
    assert.deepEqual(saved.body.assetAttributes, {
      category: "images",
      style: "pixel",
      formats: ["PNG", "SVG"],
      license: "commercial",
    });
    const replay = await f.request("PUT", `/v1/resources/${resource.id}/attributes`, payload, {
      key: requestNo,
    });
    assert.deepEqual(replay.body, saved.body);
    assert.equal(
      (
        await f.request(
          "PUT",
          `/v1/resources/${resource.id}/attributes`,
          { ...payload, style: "lowpoly" },
          { key: requestNo },
        )
      ).status,
      409,
    );

    const pixelUi = await publishArtWithAttributes(
      f,
      "Pixel Kit 像素界面",
      { category: "images", style: "pixel", formats: ["PNG", "ASEPRITE"], license: "commercial" },
      "framelab",
    );
    const forestModel = await publishArtWithAttributes(f, "低多边形森林", {
      category: "models",
      style: "lowpoly",
      formats: ["GLB", "PNG"],
      license: "personal",
    });
    const legacyArt = await publishArtWithAttributes(f, "历史未标注素材", null);

    const catalog = (query) => f.request("GET", `/v1/catalog?${query}`, undefined, { token: null });
    const ids = (res) => res.body.items.map((item) => item.id).sort();

    assert.deepEqual(
      ids(await catalog("section=assets")),
      [pixelUi.publication.id, forestModel.publication.id, legacyArt.publication.id].sort(),
    );
    assert.deepEqual(ids(await catalog("section=assets&category=images")), [
      pixelUi.publication.id,
    ]);
    assert.deepEqual(ids(await catalog("section=assets&style=lowpoly")), [
      forestModel.publication.id,
    ]);
    assert.deepEqual(
      ids(await catalog("section=assets&format=PNG")),
      [pixelUi.publication.id, forestModel.publication.id].sort(),
    );
    assert.deepEqual(ids(await catalog("section=assets&format=ASEPRITE&license=commercial")), [
      pixelUi.publication.id,
    ]);
    assert.deepEqual(ids(await catalog("section=assets&space=framelab&category=images")), [
      pixelUi.publication.id,
    ]);

    for (const bad of [
      "category=general",
      "category=bad",
      "category=images&category=models",
      "style=unknown",
      "format=EXE",
      "license=unspecified",
      `format=${encodeURIComponent("' OR 1=1 --")}`,
    ]) {
      assert.equal((await catalog(bad)).status, 400, bad);
    }

    // 发布后修改素材属性递增 revision 并破坏快照一致性，立即从公开目录移除以防绕过审核。
    const tampered = await f.request("PUT", `/v1/resources/${pixelUi.resourceId}/attributes`, {
      revision: pixelUi.resourceRevision,
      category: "models",
      style: "realistic",
      formats: ["GLB"],
      license: "personal",
    });
    assert.equal(tampered.status, 200);
    assert.equal(
      (await f.request("GET", `/v1/catalog/${pixelUi.publication.id}`, undefined, { token: null }))
        .status,
      404,
    );
    assert.deepEqual(ids(await catalog("section=assets&category=images")), []);
  } finally {
    await f.dispose();
  }
});

test("0014_asset_market_requests.sql 保数据增量迁移：失败回滚、重复执行幂等且旧数据完整保留", async () => {
  const f = await fixture({ schema: false, reviewers: reviewerConfig });
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
      result[name] = (await db.prepare(`SELECT * FROM "${name}"`).all()).results
        .map((row) => JSON.stringify(row))
        .sort();
    }
    return result;
  }
  try {
    const prior = (await readdir(new URL("../db/", import.meta.url)))
      .filter((name) => name.endsWith(".sql") && name < "0014_asset_market_requests.sql")
      .sort();
    for (const name of prior) await f.db.batch(statements(f.db, await sqlFile(name)));
    const { publication } = await hypotheticalPublication(f, { member: "user:bob" });
    await ticketFor(f, publication);
    const before = await snapshot(f.db);
    const migration = await sqlFile("0014_asset_market_requests.sql");
    await assert.rejects(
      f.db.batch([
        ...statements(f.db, migration),
        f.db.prepare("INSERT INTO nonexistent_0014_probe VALUES (1)"),
      ]),
    );
    assert.deepEqual(await snapshot(f.db), before);
    await f.db.batch(statements(f.db, migration));
    const expected = {
      ...before,
      resource_asset_attributes: [],
      version_asset_attributes: [],
      asset_requests: [],
      asset_request_responses: [],
      asset_request_events: [],
    };
    assert.deepEqual(await snapshot(f.db), expected);
    await f.db.batch(statements(f.db, migration));
    assert.deepEqual(await snapshot(f.db), expected);
    assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
    const ownerPub = await f.request("GET", `/v1/publications/${publication.id}`);
    assert.equal(ownerPub.status, 200);
    assert.deepEqual(ownerPub.body.assetAttributes, {
      category: "general",
      style: "general",
      formats: [],
      license: "unspecified",
    });
  } finally {
    await f.dispose();
  }
});
