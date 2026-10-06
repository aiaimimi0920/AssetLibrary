import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fixture } from "./fixture.mjs";
import {
  dueInspection,
  png,
  prepared,
  read,
  scheduledWithStorage,
  start,
} from "./inspection-fixture.mjs";
import { cancel, keyOf, sha256, storageOverride, tick } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
});

test("排队审计 ABORT 回滚任务，恢复后原请求只创建一份", async () => {
  const upload = await prepared(f);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_inspection_create BEFORE INSERT ON inspection_events WHEN NEW.state = 'queued' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_INSPECTION_CREATE'); END",
    )
    .run();
  try {
    const failed = await start(f, upload);
    assert.equal(failed.status, 503);
    assert.deepEqual(failed.body, { error: "SERVICE_UNAVAILABLE" });
    assert.equal((await read(f, upload)).status, 404);
  } finally {
    await f.db.prepare("DROP TRIGGER fail_inspection_create").run();
  }
  assert.equal((await start(f, upload)).status, 201);
  assert.equal((await start(f, upload)).status, 200);
  await tick(f);
  assert.equal((await read(f, upload)).body.state, "passed");
});

test("完成审计失败不保留 passed，恢复后重试且无幽灵成功事件", async () => {
  const upload = await prepared(f);
  await start(f, upload);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_inspection_finish BEFORE INSERT ON inspection_events WHEN NEW.state = 'passed' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_INSPECTION_FINISH'); END",
    )
    .run();
  try {
    await tick(f);
    const failed = (await read(f, upload)).body;
    assert.equal(failed.state, "queued");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.result, null);
    assert.equal(failed.error, "INSPECTION_TEMPORARILY_UNAVAILABLE");
    const count = await f.db
      .prepare(
        "SELECT count(*) AS n FROM inspection_events WHERE inspection_id = ? AND state = 'passed'",
      )
      .bind(failed.id)
      .first();
    assert.equal(count.n, 0);
  } finally {
    await f.db.prepare("DROP TRIGGER fail_inspection_finish").run();
  }
  await dueInspection(f, upload);
  await tick(f);
  assert.equal((await read(f, upload)).body.state, "passed");
  assert.equal((await read(f, upload)).body.attempts, 2);
});

function heldGet(upload) {
  let observed;
  let release;
  const captured = new Promise((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  return {
    captured,
    release: () => release(),
    storage: storageOverride(f, {
      get: async (key, options) => {
        const object = await f.bucket.get(key, options);
        if (key === keyOf(upload)) {
          observed();
          await barrier;
        }
        return object;
      },
    }),
  };
}

test("持有旧对象的检查与取消竞争，只提交 invalidated，不能写 passed", async () => {
  const upload = await prepared(f);
  await start(f, upload);
  const hold = heldGet(upload);
  const pending = scheduledWithStorage(f, hold.storage);
  try {
    await hold.captured;
    assert.equal((await read(f, upload)).body.state, "running");
    assert.equal((await cancel(f, upload)).status, 200);
  } finally {
    hold.release();
  }
  await pending;
  const result = (await read(f, upload)).body;
  assert.equal(result.state, "invalidated");
  assert.equal(result.bindingCurrent, false);
  assert.equal(result.result, null);
  const events = await f.db
    .prepare("SELECT state FROM inspection_events WHERE inspection_id = ? ORDER BY revision")
    .bind(result.id)
    .all();
  assert.deepEqual(
    events.results.map((row) => row.state),
    ["queued", "running", "invalidated"],
  );
});

test("过期租约恢复后旧执行者被 token 隔离，不能覆盖新检查或重复审计", async () => {
  const upload = await prepared(f);
  await start(f, upload);
  const hold = heldGet(upload);
  const pending = scheduledWithStorage(f, hold.storage);
  let newResult;
  try {
    await hold.captured;
    assert.equal((await read(f, upload)).body.attempts, 1);
    // 只模拟租约时间前进，不重置已消耗次数、token 或审计。
    await dueInspection(f, upload);
    await tick(f);
    newResult = (await read(f, upload)).body;
    assert.equal(newResult.state, "passed");
    assert.equal(newResult.attempts, 2);
  } finally {
    hold.release();
  }
  await pending;
  assert.deepEqual((await read(f, upload)).body, newResult);
  const events = await f.db
    .prepare("SELECT state FROM inspection_events WHERE inspection_id = ? ORDER BY revision")
    .bind(newResult.id)
    .all();
  assert.deepEqual(
    events.results.map((row) => row.state),
    ["queued", "running", "running", "passed"],
  );
});

test("R2 临时故障最多三次执行，耗尽后重复请求不能重置消费次数", async () => {
  const upload = await prepared(f);
  await start(f, upload);
  const storage = storageOverride(f, {
    get: async () => {
      throw new Error("TEST_ONLY_R2_GET_FAILURE");
    },
  });
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dueInspection(f, upload);
    await scheduledWithStorage(f, storage);
    const result = (await read(f, upload)).body;
    assert.equal(result.attempts, attempt);
    assert.equal(result.state, attempt === 3 ? "failed" : "queued");
    assert.equal(result.result, null);
  }
  const exhausted = (await read(f, upload)).body;
  assert.deepEqual((await start(f, upload)).body, exhausted);
  await tick(f);
  assert.deepEqual((await read(f, upload)).body, exhausted);
});

test("第三次执行中断后取消或删除，租约回收优先记 invalidated 而不是 failed", async () => {
  for (const action of ["cancel", "delete-resource"]) {
    const upload = await prepared(f);
    await start(f, upload);
    const unavailable = storageOverride(f, {
      get: async () => {
        throw new Error("TEST_ONLY_GET_RETRY");
      },
    });
    for (let i = 0; i < 2; i++) {
      await dueInspection(f, upload);
      await scheduledWithStorage(f, unavailable);
    }
    await dueInspection(f, upload);
    const hold = heldGet(upload);
    const pending = scheduledWithStorage(f, hold.storage);
    try {
      await hold.captured;
      assert.equal((await read(f, upload)).body.attempts, 3);
      if (action === "cancel") await cancel(f, upload);
      else
        assert.equal(
          (await f.request("DELETE", `/v1/resources/${upload.resourceId}`, { revision: 1 })).status,
          200,
        );
      await dueInspection(f, upload);
      await tick(f);
      assert.equal((await read(f, upload)).body.state, "invalidated");
      assert.equal((await read(f, upload)).body.error, "INSPECTION_BINDING_CHANGED");
    } finally {
      hold.release();
    }
    await pending;
    const result = (await read(f, upload)).body;
    assert.equal(result.attempts, 3);
    assert.equal(result.result, null);
    const events = await f.db
      .prepare("SELECT state FROM inspection_events WHERE inspection_id = ? ORDER BY revision")
      .bind(result.id)
      .all();
    assert.equal(events.results.at(-1).state, "invalidated");
    assert.ok(events.results.every((row) => row.state !== "passed" && row.state !== "failed"));
  }
});

test("每轮最多三项内容检查；R2 对象缺失或被替换不能通过", async () => {
  const uploads = [];
  for (let i = 0; i < 4; i++) {
    const upload = await prepared(f);
    uploads.push(upload);
    await start(f, upload);
  }
  await tick(f);
  const first = await Promise.all(uploads.map((upload) => read(f, upload)));
  assert.equal(first.filter((result) => result.body.state === "passed").length, 3);
  assert.equal(first.filter((result) => result.body.state === "queued").length, 1);
  await tick(f);
  assert.ok(
    (await Promise.all(uploads.map((upload) => read(f, upload)))).every(
      (result) => result.body.state === "passed",
    ),
  );
  const missing = await prepared(f);
  await start(f, missing);
  await f.bucket.delete(keyOf(missing));
  await tick(f);
  assert.equal((await read(f, missing)).body.state, "rejected");
  assert.equal((await read(f, missing)).body.error, "OBJECT_MISSING");
  const replaced = await prepared(f);
  await start(f, replaced);
  const changed = png(2, 1);
  // 仅模拟受控本地存储漂移；业务 PUT 仍禁止覆盖对象。
  await f.bucket.put(keyOf(replaced), changed, { sha256: sha256(changed) });
  await tick(f);
  assert.equal((await read(f, replaced)).body.state, "rejected");
  assert.equal((await read(f, replaced)).body.error, "OBJECT_IDENTITY_CHANGED");
});
