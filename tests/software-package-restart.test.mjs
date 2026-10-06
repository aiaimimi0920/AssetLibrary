import assert from "node:assert/strict";
import { test } from "node:test";
import { contentRequest, coreModules, denied, ticketFor } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { read } from "./inspection-fixture.mjs";
import { checkedRestart, durableSnapshot, inspectionStates } from "./runtime-restart-fixture.mjs";
import { cleanFact, jsonFact, runScanner } from "./scanner-fixture.mjs";
import {
  checkedSoftware,
  queueSoftware,
  softwareBytes,
  softwarePolicy,
} from "./software-package-fixture.mjs";
import { cancel, keyOf, sha256 } from "./upload-fixture.mjs";
import { createVersion, readVersion, review, reviewerConfig } from "./version-fixture.mjs";

async function preservedRestart(f, uploads) {
  const snapshot = await durableSnapshot(f);
  const objects = await Promise.all(
    uploads.map(async (upload) => {
      const object = await f.bucket.get(keyOf(upload));
      assert.ok(object);
      return { etag: object.etag, bytes: Buffer.from(await object.arrayBuffer()) };
    }),
  );
  await checkedRestart(f);
  assert.deepEqual(await durableSnapshot(f), snapshot);
  for (const [index, upload] of uploads.entries()) {
    const object = await f.bucket.get(keyOf(upload));
    assert.ok(object);
    assert.equal(object.etag, objects[index].etag);
    assert.deepEqual(Buffer.from(await object.arrayBuffer()), objects[index].bytes);
  }
}

async function library(core, f) {
  return (
    await core.listPublications(f.db, new URL("http://local/v1/me/library"), "user:bob")
  ).json();
}

for (const kind of ["capability", "application"]) {
  test(`${kind} 完整重开恢复待检查包；取消不复活、扫描只提交一次且审核事实保留`, async () => {
    const f = await fixture({ reviewers: reviewerConfig });
    try {
      const bytes = softwareBytes(kind);
      const upload = await queueSoftware(f, kind, bytes);
      const cancelled = await queueSoftware(f, kind, bytes);
      assert.equal((await cancel(f, cancelled)).status, 200);
      await preservedRestart(f, [upload]);
      assert.equal((await read(f, upload)).body.state, "queued");
      assert.equal((await f.request("GET", `/v1/uploads/${cancelled.id}`)).body.state, "cancelled");
      assert.equal(await f.bucket.head(keyOf(cancelled)), null);
      const calls = [];
      const scanner = {
        async fetch(request) {
          assert.equal(request.headers.get("x-object-sha256"), upload.sha256);
          calls.push(Buffer.from(await request.arrayBuffer()));
          return jsonFact(cleanFact(upload));
        },
      };
      await runScanner(f, scanner);
      await runScanner(f, scanner);
      assert.deepEqual(calls, [bytes]);
      // 上传取消立即生效；检查任务在实际调度时记录 invalidated，不能变成 passed。
      const invalidated = (await read(f, cancelled)).body;
      assert.equal(invalidated.state, "invalidated");
      assert.equal(invalidated.attempts, 0);
      assert.equal(invalidated.result, null);
      assert.deepEqual(await inspectionStates(f, invalidated.id), ["queued", "invalidated"]);
      const checked = (await read(f, upload)).body;
      assert.equal(checked.state, "passed");
      assert.equal(checked.policy, softwarePolicy(kind));
      assert.equal(checked.result.kind, kind);
      assert.deepEqual(await inspectionStates(f, checked.id), ["queued", "running", "passed"]);
      const created = await createVersion(f, upload);
      assert.equal(created.status, 201);
      const approved = await review(f, created.body);
      assert.equal(approved.status, 200);
      await preservedRestart(f, [upload]);
      assert.deepEqual((await read(f, upload)).body, checked);
      assert.deepEqual((await readVersion(f, approved.body)).body, approved.body);
      await runScanner(f, scanner);
      assert.deepEqual(calls, [bytes]);
      assert.equal((await f.request("GET", `/v1/uploads/${cancelled.id}`)).body.state, "cancelled");
    } finally {
      await f.dispose();
    }
  });

  test(`${kind} 重开保留授权与同包续传；撤销/恢复不复活旧票据，下架终态跨重开保持`, async () => {
    const f = await fixture({ reviewers: reviewerConfig });
    try {
      const core = await coreModules();
      const { upload, bytes } = await checkedSoftware(f, kind);
      const created = await createVersion(f, upload);
      assert.equal(created.status, 201);
      const approved = await review(f, created.body);
      assert.equal(approved.status, 200);
      // 只在宿主调用既有业务核心假设准入；HTTP Worker 没有生产发布开关。
      const published = await core.publishVersion(
        f.db,
        created.body.id,
        "user:alice",
        approved.body.revision,
      );
      assert.equal(published.status, 201);
      const publication = await published.json();
      const grant = `/v1/publications/${publication.id}/grants/user:bob`;
      assert.equal((await f.request("PUT", grant, { revision: 0 })).status, 200);
      const ticket = await ticketFor(f, publication, "user:bob");
      await preservedRestart(f, [upload]);
      assert.equal((await library(core, f)).items[0].kind, kind);
      for (const partial of [false, true]) {
        const response = await core.downloadContent(
          contentRequest(publication, ticket, {
            headers: partial ? { range: "bytes=3-17" } : {},
          }),
          f.env,
          publication.id,
          "user:bob",
        );
        assert.equal(response.status, partial ? 206 : 200);
        const actual = Buffer.from(await response.arrayBuffer());
        assert.deepEqual(actual, partial ? bytes.subarray(3, 18) : bytes);
        if (!partial) assert.equal(sha256(actual), publication.sha256);
      }
      assert.equal(
        (await f.request("POST", `/v1/publications/${publication.id}/tickets`, {})).body.error,
        "SCANNER_CLOUD_NOT_VALIDATED",
      );
      assert.equal((await f.request("DELETE", grant, { revision: 1 })).status, 200);
      await preservedRestart(f, [upload]);
      assert.deepEqual((await library(core, f)).items, []);
      await denied(core.authorizeTicket(f.db, publication.id, "user:bob", ticket.ticket));
      assert.equal((await f.request("PUT", grant, { revision: 2 })).status, 200);
      await denied(core.authorizeTicket(f.db, publication.id, "user:bob", ticket.ticket));
      const fresh = await ticketFor(f, publication, "user:bob");
      assert.equal(
        (await core.unlistPublication(f.db, publication.id, "user:alice", 1)).status,
        200,
      );
      await preservedRestart(f, [upload]);
      assert.deepEqual((await library(core, f)).items, []);
      await denied(
        core.downloadContent(contentRequest(publication, fresh), f.env, publication.id, "user:bob"),
      );
      const history = await f.request("GET", `/v1/publications/${publication.id}`);
      assert.equal(history.status, 200);
      assert.equal(history.body.state, "unlisted");
      assert.equal(history.body.revision, 2);
    } finally {
      await f.dispose();
    }
  });
}
