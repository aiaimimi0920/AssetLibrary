import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fixture } from "./fixture.mjs";
import { png, prepared, start } from "./inspection-fixture.mjs";
import { cancel, keyOf, tick } from "./upload-fixture.mjs";
import {
  checkedUpload,
  createVersion,
  creationBody,
  events,
  readVersion,
  readyVersion,
  review,
  reviewerConfig,
  withdraw,
} from "./version-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
});
after(async () => {
  await f?.dispose();
});

test("真实 Worker/D1/R2：不可变版本、独立批准、发布拒绝及撤回的闭环", async () => {
  const { upload, version } = await readyVersion(f);
  assert.equal(version.state, "pending_review");
  assert.equal(version.bindingCurrent, true);
  assert.equal(version.snapshot.sha256, upload.sha256);
  assert.equal(version.snapshot.uploadRevision, 2);
  const approved = await review(f, version);
  assert.equal(approved.status, 200);
  assert.equal(approved.body.state, "approved");
  assert.equal(approved.body.revision, 2);
  assert.deepEqual(approved.body.snapshot, version.snapshot);
  assert.equal(approved.body.review.reviewer, "user:reviewer");
  assert.equal(approved.body.publicationEligible, false);
  assert.deepEqual(approved.body.publicationBlockers, ["REQUIRED_CONTENT_CHECK_UNAVAILABLE"]);
  const publish = await f.request("POST", `/v1/versions/${version.id}/publish`, { revision: 2 });
  assert.equal(publish.status, 409);
  assert.equal(publish.body.error, "REQUIRED_CONTENT_CHECK_UNAVAILABLE");
  assert.equal((await f.request("GET", `/v1/uploads/${upload.id}`)).body.state, "quarantined");
  assert.ok(await f.bucket.head(keyOf(upload)));
  for (const path of [`/v1/versions/${version.id}/download`])
    assert.equal((await f.request("GET", path)).status, 404);
  assert.equal((await f.request("GET", "/v1/catalog")).body.error, "SCANNER_CLOUD_NOT_VALIDATED");
  const withdrawn = await withdraw(f, approved.body);
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.body.state, "withdrawn");
  assert.equal(withdrawn.body.revision, 3);
  assert.deepEqual(withdrawn.body.review, approved.body.review);
  assert.deepEqual(withdrawn.body.snapshot, version.snapshot);
  assert.deepEqual(
    (await events(f, version)).map((e) => e.action),
    ["created", "approved", "withdrawn"],
  );
});

test("未完成、排队、拒绝或失效 inspection 不能绑定版本；软件包也必须先完成对应检查", async () => {
  const upload = await prepared(f);
  assert.equal((await createVersion(f, upload)).body.error, "VERSION_BINDING_NOT_READY");
  await start(f, upload);
  assert.equal((await createVersion(f, upload)).status, 409);
  await tick(f);
  await cancel(f, upload);
  assert.equal((await createVersion(f, upload)).status, 409);
  const rejected = await prepared(f, Buffer.from("not png"));
  await start(f, rejected);
  await tick(f);
  assert.equal((await createVersion(f, rejected)).status, 409);
  for (const kind of ["capability", "application"]) {
    const other = await prepared(f, png(), kind);
    assert.equal((await createVersion(f, other)).body.error, "VERSION_BINDING_NOT_READY");
  }
  const count = await f.db
    .prepare("SELECT count(*) AS n FROM versions WHERE upload_id IN (?, ?)")
    .bind(upload.id, rejected.id)
    .first();
  assert.equal(count.n, 0);
});

test("并发创建同标签只有一次事实；冲突输入、撤回和失效后重放不重置版本", async () => {
  const upload = await checkedUpload(f);
  const body = await creationBody(f, upload);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => createVersion(f, upload, body)),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.ok(results.every((r) => r.body.id === results[0].body.id));
  const version = results[0].body;
  assert.equal((await events(f, version)).length, 1);
  assert.equal(
    (await createVersion(f, upload, { ...body, resourceRevision: 2 })).body.error,
    "VERSION_LABEL_CONFLICT",
  );
  const anotherUpload = await f.request("POST", `/v1/resources/${upload.resourceId}/uploads`, {
    size: png().length,
    sha256: upload.sha256,
  });
  assert.equal(anotherUpload.status, 201);
  assert.equal(
    (await createVersion(f, upload, { ...body, uploadId: anotherUpload.body.id })).body.error,
    "VERSION_LABEL_CONFLICT",
  );
  const other = await checkedUpload(f);
  assert.equal((await createVersion(f, upload, { ...body, uploadId: other.id })).status, 404);
  const withdrawn = await withdraw(f, version);
  await cancel(f, upload);
  const replay = await createVersion(f, upload, body);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.state, "withdrawn");
  assert.equal(replay.body.revision, withdrawn.body.revision);
  assert.equal(replay.body.bindingCurrent, false);
  assert.equal((await events(f, version)).length, 2);
});

test("私有版本只允许 owner 或固定 reviewer 查询，成员与伪造角色不能越权", async () => {
  const { upload, version } = await readyVersion(f);
  assert.equal(
    (await f.request("PUT", `/v1/resources/${upload.resourceId}/members/user:bob`, { revision: 1 }))
      .status,
    200,
  );
  assert.equal((await readVersion(f, version, { principal: "user:reviewer" })).status, 200);
  for (const principal of ["user:bob", "user:eve"]) {
    assert.equal((await readVersion(f, version, { principal })).status, 404);
    for (const action of ["withdraw", "publish"])
      assert.equal(
        (
          await f.request(
            "POST",
            `/v1/versions/${version.id}/${action}`,
            { revision: 1 },
            { principal },
          )
        ).status,
        404,
      );
  }
  const forged = await f.token("user:bob", { role: "reviewer", roles: ["reviewer"] });
  assert.equal(
    (await readVersion(f, version, { token: forged, headers: { "x-role": "reviewer" } })).status,
    404,
  );
  assert.equal((await review(f, version, {}, { token: forged })).status, 404);
  assert.equal((await readVersion(f, version, { token: "invalid" })).status, 401);
  assert.equal((await createVersion(f, upload, undefined, { principal: "user:bob" })).status, 404);
});

test("版本输入拒绝越界标签、UUID、revision、额外字段和恶意 SQL 文本", async () => {
  const upload = await checkedUpload(f);
  const body = await creationBody(f, upload);
  for (const changes of [
    { label: "" },
    { label: "a".repeat(65) },
    { label: "v1'; DROP TABLE versions;--" },
    { label: "../v1" },
    { uploadId: "not-uuid" },
    { resourceRevision: 0 },
    { resourceRevision: 1.5 },
    { state: "approved" },
    { sha256: "forged" },
  ])
    assert.equal((await createVersion(f, upload, { ...body, ...changes })).status, 400);
  const created = await createVersion(f, upload, { ...body, label: "A".repeat(64) });
  assert.equal(created.status, 201);
  assert.equal(
    (await f.request("PATCH", `/v1/versions/${created.body.id}`, { label: "new" })).status,
    404,
  );
  assert.equal(
    (
      await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
        revision: 1,
        allowUnsafe: true,
      })
    ).status,
    400,
  );
});
