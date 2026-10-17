import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { coreModules } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { releaseFixture } from "./scanner-deployment-fixture.mjs";
import { cleanFact, jsonFact, queuedScan, runScanner } from "./scanner-fixture.mjs";
import { createVersion, heldBatch, review, reviewerConfig } from "./version-fixture.mjs";

let core;
const runtimes = [];
before(async () => {
  core = await coreModules();
});
after(async () => {
  for (const f of runtimes) await f.dispose();
});
async function deployed(document, overrides = {}) {
  const f = await fixture({
    reviewers: reviewerConfig,
    deploymentDocument: document,
    deploymentBindings: {
      APP_ORIGIN: { type: "text", value: document.release.origin },
      SCANNER_RELEASE_ID: { type: "text", value: document.release.id },
      SCANNER: { type: "fetcher", handler: () => new Response(null, { status: 503 }) },
      ...overrides,
    },
  });
  runtimes.push(f);
  return f;
}
async function approved(f, release, changes = {}) {
  const upload = await queuedScan(f);
  await runScanner(f, {
    fetch: async () => jsonFact(cleanFact(upload, { database: release.database, ...changes })),
  });
  const created = await createVersion(f, upload);
  assert.equal(created.status, 201);
  const reviewed = await review(f, created.body);
  assert.equal(reviewed.status, 200);
  return reviewed.body;
}

test("版本内验收记录严格解析，缺证、畸形、过期和超长有效期均失败关闭", () => {
  const now = Date.now();
  const valid = releaseFixture(now);
  assert.deepEqual(core.parseDeploymentRelease(valid, now), valid.release);
  const mutate = (change) => {
    const doc = structuredClone(valid);
    change(doc);
    return doc;
  };
  for (const doc of [
    null,
    {},
    { schemaVersion: 1, release: null },
    mutate((d) => {
      d.schemaVersion = true;
    }),
    mutate((d) => {
      d.release.extra = true;
    }),
    mutate((d) => {
      d.release.id = "enabled";
    }),
    mutate((d) => {
      d.release.database.dailyVersion = true;
    }),
    mutate((d) => {
      d.release.validatedAt = now + 1;
    }),
    mutate((d) => {
      d.release.expiresAt = now;
    }),
    mutate((d) => {
      d.release.expiresAt = d.release.validatedAt + 86400001;
    }),
    mutate((d) => {
      d.release.database.updatedAt = now - 172800001;
    }),
    mutate((d) => {
      d.release.origin += "/";
    }),
    mutate((d) => {
      d.release.evidence.nativeReview = "";
    }),
    mutate((d) => {
      d.release.service = d.release.worker;
    }),
  ])
    assert.equal(core.parseDeploymentRelease(doc, now), null);
});

test("扫描部署不匹配不阻断未扫描目录，但不能放行扫描版本", async () => {
  const doc = releaseFixture();
  for (const bindings of [
    { SCANNER_RELEASE_ID: { type: "text", value: "wrong" } },
    { APP_ORIGIN: { type: "text", value: "https://other.invalid" } },
  ]) {
    const f = await deployed(doc, bindings);
    assert.deepEqual((await f.request("GET", "/v1/catalog")).body.items, []);
    assert.equal((await f.request("GET", "/readyz")).body.distribution.mode, "unscanned-packages");
    const version = await approved(f, doc.release);
    assert.equal(version.publicationEligible, false);
    assert.equal(
      (
        await f.request("POST", `/v1/versions/${version.id}/publish`, {
          revision: version.revision,
        })
      ).status,
      409,
    );
  }
});

test("真实准入路径：匹配验收身份后审核、发布、票据及 R2 下载，撤销仍立即拒绝", async () => {
  const doc = releaseFixture();
  const f = await deployed(doc);
  const ready = (await f.request("GET", "/readyz")).body;
  assert.deepEqual(ready.distribution, {
    status: "available",
    mode: "unscanned-packages",
    malwareScanning: "not_required",
  });
  const version = await approved(f, doc.release);
  assert.equal(version.contentSafety.cloudValidated, true);
  assert.equal(version.publicationEligible, true);
  assert.deepEqual(version.publicationBlockers, []);
  const published = await f.request("POST", `/v1/versions/${version.id}/publish`, {
    revision: version.revision,
  });
  assert.equal(published.status, 201);
  const publication = published.body;
  assert.equal((await f.request("GET", "/v1/catalog")).body.items[0].id, publication.id);
  const route = `/v1/publications/${publication.id}`;
  assert.equal((await f.request("PUT", `${route}/grants/user:bob`, { revision: 0 })).status, 200);
  const ticket = await f.request("POST", `${route}/tickets`, {}, { principal: "user:bob" });
  assert.equal(ticket.status, 201);
  assert.ok(ticket.body.expiresAt <= doc.release.expiresAt);
  const headers = {
    authorization: `Bearer ${await f.token("user:bob")}`,
    "x-download-ticket": ticket.body.ticket,
  };
  const content = await f.mf.dispatchFetch(`http://localhost${route}/content`, { headers });
  assert.equal(content.status, 200);
  assert.equal((await content.arrayBuffer()).byteLength, publication.size);
  assert.equal(
    (await f.request("DELETE", `${route}/grants/user:bob`, { revision: 1 })).status,
    200,
  );
  const denied = await f.mf.dispatchFetch(`http://localhost${route}/content`, { headers });
  assert.equal(denied.status, 404);
  await denied.text();
  const expired = { ...doc.release, expiresAt: Date.now() - 1 };
  await assert.rejects(
    core.issueTicket(f.db, publication.id, "user:alice", expired),
    (e) => e.code === "NOT_FOUND",
  );
});

test("不同数据库的 clean 不借用新验收发布，历史扫描也不自动升级", async () => {
  const doc = releaseFixture();
  const f = await deployed(doc);
  const version = await approved(f, doc.release, {
    database: { ...doc.release.database, sha256: "b".repeat(64) },
  });
  assert.equal(version.contentSafety.scanCurrent, true);
  assert.equal(version.contentSafety.cloudValidated, false);
  const denied = await f.request("POST", `/v1/versions/${version.id}/publish`, {
    revision: version.revision,
  });
  assert.equal(denied.status, 409);
  assert.equal(denied.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
  const scan = cleanFact(
    { sha256: "a".repeat(64), size: 1 },
    { database: doc.release.database, completedAt: doc.release.validatedAt - 1 },
  );
  assert.equal(core.admittedScan(scan, doc.release), false);
});

test("发布事务等待期间验收过期，不写发布事实或成功审计", async () => {
  const doc = releaseFixture();
  const f = await deployed(doc);
  const version = await approved(f, doc.release);
  const release = { ...doc.release, expiresAt: Date.now() + 1000 };
  const held = heldBatch(f);
  const publishing = core.publishVersion(
    held.db,
    version.id,
    "user:alice",
    version.revision,
    release,
  );
  const denied = assert.rejects(publishing, (error) => error.status === 409);
  try {
    await held.captured;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, release.expiresAt - Date.now()) + 50),
    );
  } finally {
    held.release();
  }
  await denied;
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM publications").first()).n, 0);
  assert.equal((await f.db.prepare("SELECT count(*) AS n FROM publication_events").first()).n, 0);
});
