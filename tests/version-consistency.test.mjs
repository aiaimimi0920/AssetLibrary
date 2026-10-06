import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fixture } from "./fixture.mjs";
import { cancel } from "./upload-fixture.mjs";
import {
  callWithEnv,
  checkedUpload,
  createVersion,
  creationBody,
  events,
  heldBatch,
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

test("创建审计 ABORT 整批回滚，不消耗标签；恢复后只创建一次", async () => {
  const upload = await checkedUpload(f);
  const body = await creationBody(f, upload);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_version_create BEFORE INSERT ON version_events WHEN NEW.action = 'created' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_VERSION_CREATE'); END",
    )
    .run();
  try {
    const result = await createVersion(f, upload, body);
    assert.equal(result.status, 503);
    assert.deepEqual(result.body, { error: "SERVICE_UNAVAILABLE" });
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM versions WHERE resource_id = ?")
          .bind(upload.resourceId)
          .first()
      ).n,
      0,
    );
  } finally {
    await f.db.prepare("DROP TRIGGER fail_version_create").run();
  }
  const created = await createVersion(f, upload, body);
  assert.equal(created.status, 201);
  assert.equal((await createVersion(f, upload, body)).status, 200);
  assert.equal((await events(f, created.body)).length, 1);
});

test("批准和撤回审计失败均回滚状态及 revision，原请求恢复后可重试", async () => {
  const { version } = await readyVersion(f);
  for (const action of ["approved", "withdrawn"]) {
    const previous = (await readVersion(f, version)).body;
    await f.db
      .prepare(
        `CREATE TRIGGER fail_version_decision BEFORE INSERT ON version_events WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_VERSION_DECISION'); END`,
      )
      .run();
    try {
      const failed =
        action === "approved" ? await review(f, previous) : await withdraw(f, previous);
      assert.equal(failed.status, 503);
      assert.deepEqual(failed.body, { error: "SERVICE_UNAVAILABLE" });
      assert.deepEqual((await readVersion(f, version)).body, previous);
      assert.equal((await events(f, version)).length, previous.revision);
    } finally {
      await f.db.prepare("DROP TRIGGER fail_version_decision").run();
    }
    const succeeded =
      action === "approved" ? await review(f, previous) : await withdraw(f, previous);
    assert.equal(succeeded.status, 200);
    assert.equal(succeeded.body.revision, previous.revision + 1);
    assert.equal((await events(f, version)).length, previous.revision + 1);
  }
});

test("两个独立 reviewer 的相反决定竞争只有一个成功且只写一次决定", async () => {
  const { version } = await readyVersion(f);
  const responses = await Promise.all([
    review(f, version),
    review(
      f,
      version,
      { decision: "rejected", reason: "另一审核决定" },
      { principal: "user:reviewer2" },
    ),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = (await readVersion(f, version)).body;
  const succeeded = responses.find((r) => r.status === 200);
  assert.deepEqual(current, succeeded.body);
  assert.equal(current.revision, 2);
  assert.equal((await events(f, version)).length, 2);
});

test("批准与 owner 撤回竞争不会覆盖先完成的决定或生成幽灵审计", async () => {
  const { version } = await readyVersion(f);
  const responses = await Promise.all([review(f, version), withdraw(f, version)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = (await readVersion(f, version)).body;
  assert.equal(current.state, responses.find((r) => r.status === 200).body.state);
  assert.equal(current.revision, 2);
  assert.equal((await events(f, version)).length, 2);
});

test("创建预检后资源发生变化，事务内复核拒绝创建，不能留下空壳版本", async () => {
  const upload = await checkedUpload(f);
  const body = await creationBody(f, upload);
  const hold = heldBatch(f);
  const pending = callWithEnv(
    f,
    "POST",
    `/v1/resources/${upload.resourceId}/versions`,
    body,
    { DB: hold.db },
    "user:alice",
  );
  try {
    await hold.captured;
    assert.equal(
      (
        await f.request("PATCH", `/v1/resources/${upload.resourceId}`, {
          revision: 1,
          title: "竞争修改",
        })
      ).status,
      200,
    );
  } finally {
    hold.release();
  }
  const result = await pending;
  assert.equal(result.status, 409);
  assert.equal(result.body.error, "VERSION_BINDING_NOT_READY");
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM versions WHERE resource_id = ?")
        .bind(upload.resourceId)
        .first()
    ).n,
    0,
  );
});

test("批准预检后取消、删除或成员变更，原子准入拒绝，不能写 approved 事件", async () => {
  for (const action of ["cancel", "delete", "grant"]) {
    const { upload, version } = await readyVersion(f);
    const hold = heldBatch(f);
    const pending = callWithEnv(
      f,
      "POST",
      `/v1/versions/${version.id}/review`,
      {
        revision: 1,
        decision: "approved",
        reason: "竞争中的测试决定",
      },
      { DB: hold.db },
    );
    try {
      await hold.captured;
      if (action === "cancel") await cancel(f, upload);
      else if (action === "delete")
        assert.equal(
          (await f.request("DELETE", `/v1/resources/${upload.resourceId}`, { revision: 1 })).status,
          200,
        );
      else
        assert.equal(
          (
            await f.request("PUT", `/v1/resources/${upload.resourceId}/members/user:bob`, {
              revision: 1,
            })
          ).status,
          200,
        );
    } finally {
      hold.release();
    }
    const result = await pending;
    assert.equal(result.status, 409);
    assert.equal(result.body.error, "VERSION_BINDING_CHANGED");
    const current = (await readVersion(f, version)).body;
    assert.equal(current.state, "pending_review");
    assert.equal(current.review, null);
    assert.equal(current.bindingCurrent, false);
    assert.equal((await events(f, version)).length, 1);
  }
});
