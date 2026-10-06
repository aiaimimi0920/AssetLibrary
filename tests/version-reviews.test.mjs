import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fixture } from "./fixture.mjs";
import { cancel } from "./upload-fixture.mjs";
import {
  callWithEnv,
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

test("审核名单缺失、非法、重复或越界失败关闭，不影响 owner 读取历史", async () => {
  const { version } = await readyVersion(f);
  const body = { revision: 1, decision: "approved", reason: "测试" };
  for (const encoded of [
    undefined,
    "",
    "not json",
    "{}",
    "[]",
    '["invalid principal"]',
    '["user:reviewer","user:reviewer"]',
    JSON.stringify(Array.from({ length: 33 }, (_, i) => `user:${i}`)),
    " ".repeat(8193),
    '["user:Reviewer"]',
  ]) {
    const response = await callWithEnv(f, "POST", `/v1/versions/${version.id}/review`, body, {
      REVIEWER_PRINCIPALS: encoded,
    });
    assert.equal(response.status, encoded === '["user:Reviewer"]' ? 404 : 503);
    const owner = await callWithEnv(
      f,
      "GET",
      `/v1/versions/${version.id}`,
      undefined,
      { REVIEWER_PRINCIPALS: encoded },
      "user:alice",
    );
    assert.equal(owner.status, 200);
    const outsider = await callWithEnv(f, "GET", `/v1/versions/${version.id}`, undefined, {
      REVIEWER_PRINCIPALS: encoded,
    });
    assert.equal(outsider.status, 404);
  }
  assert.equal((await events(f, version)).length, 1);
});

test("owner 即使被配置为 reviewer 也不能自审，审核权限不能由输入指定", async () => {
  const { version } = await readyVersion(f);
  assert.equal(
    (await review(f, version, {}, { principal: "user:alice" })).body.error,
    "SELF_REVIEW_FORBIDDEN",
  );
  assert.equal((await review(f, version, {}, { principal: "user:eve" })).status, 404);
  for (const body of [
    { decision: "published" },
    { reason: "" },
    { reason: " ".repeat(3) },
    { reason: "a".repeat(501) },
    { reason: "bad\nreason" },
    { reviewer: "user:reviewer" },
    { revision: 0 },
    { policyPassed: true },
  ])
    assert.equal((await review(f, version, body)).status, 400);
  assert.equal((await review(f, version, { reason: "a".repeat(500) })).status, 200);
});

test("审核终态及完全相同重放不重复写审计，不同理由、审核者或反向决定冲突", async () => {
  const { version } = await readyVersion(f);
  const approved = await review(f, version);
  assert.equal(approved.status, 200);
  const replay = await review(f, version);
  assert.equal(replay.status, 200);
  assert.deepEqual(replay.body, approved.body);
  assert.equal((await review(f, version, { reason: "不同说明" })).status, 409);
  assert.equal((await review(f, version, {}, { principal: "user:reviewer2" })).status, 409);
  assert.equal((await review(f, approved.body, { decision: "rejected" })).status, 409);
  assert.equal((await events(f, version)).length, 2);
  const withdrawn = await withdraw(f, approved.body);
  assert.equal((await withdraw(f, approved.body)).status, 200);
  assert.deepEqual((await readVersion(f, version)).body, withdrawn.body);
  assert.equal((await review(f, version)).status, 409);
  assert.equal((await events(f, version)).length, 3);
});

test("失效版本仍可拒绝和撤回，拒绝不能再批准，历史决定保留", async () => {
  const { upload, version } = await readyVersion(f);
  await cancel(f, upload);
  const rejected = await review(f, version, { decision: "rejected", reason: "对象已经取消" });
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.bindingCurrent, false);
  assert.equal(rejected.body.state, "rejected");
  assert.equal((await review(f, rejected.body)).status, 409);
  const withdrawn = await withdraw(f, rejected.body);
  assert.equal(withdrawn.status, 200);
  assert.deepEqual(withdrawn.body.review, rejected.body.review);
  assert.equal((await events(f, version)).length, 3);
});

test("资源修改、成员 grant/revoke、删除和上传取消使批准绑定即时失效，历史不重写", async () => {
  for (const action of ["title", "grant", "revoke", "delete", "cancel"]) {
    const { upload, version } = await readyVersion(f);
    const approved = (await review(f, version)).body;
    if (action === "cancel") await cancel(f, upload);
    else if (action === "title")
      assert.equal(
        (
          await f.request("PATCH", `/v1/resources/${upload.resourceId}`, {
            revision: 1,
            title: "新标题",
          })
        ).status,
        200,
      );
    else if (action === "delete")
      assert.equal(
        (await f.request("DELETE", `/v1/resources/${upload.resourceId}`, { revision: 1 })).status,
        200,
      );
    else
      assert.equal(
        (
          await f.request(
            action === "grant" ? "PUT" : "DELETE",
            `/v1/resources/${upload.resourceId}/members/user:bob`,
            { revision: 1 },
          )
        ).status,
        200,
      );
    const current = (await readVersion(f, version)).body;
    assert.equal(current.state, "approved");
    assert.equal(current.bindingCurrent, false, action);
    assert.deepEqual(current.review, approved.review);
    assert.deepEqual(current.snapshot, version.snapshot);
    const publish = await f.request("POST", `/v1/versions/${version.id}/publish`, { revision: 2 });
    assert.equal(publish.body.error, "VERSION_BINDING_CHANGED");
    assert.equal((await events(f, version)).length, 2);
    assert.equal((await withdraw(f, approved)).status, 200);
  }
});

test("待审版本的 inspection revision 或 upload 身份漂移不能批准", async () => {
  for (const field of ["inspection_revision", "sha256", "etag"]) {
    const { upload, version } = await readyVersion(f);
    if (field === "inspection_revision")
      await f.db
        .prepare("UPDATE inspections SET revision = revision + 1 WHERE upload_id = ?")
        .bind(upload.id)
        .run();
    else
      await f.db
        .prepare(`UPDATE uploads SET ${field} = ? WHERE id = ?`)
        .bind(field === "sha256" ? "0".repeat(64) : "different-etag", upload.id)
        .run();
    assert.equal((await review(f, version)).body.error, "VERSION_BINDING_CHANGED");
    assert.equal((await events(f, version)).length, 1);
  }
});
