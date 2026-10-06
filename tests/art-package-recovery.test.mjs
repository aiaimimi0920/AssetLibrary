import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { packageBytes, packagePolicy, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { dueInspection, prepared, read, scheduledWithStorage } from "./inspection-fixture.mjs";
import { cancel, keyOf, storageOverride, tick } from "./upload-fixture.mjs";

let f;
before(async () => {
  f = await fixture();
});
after(async () => {
  await f?.dispose();
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
  const storage = storageOverride(f, {
    get: async (key, options) => {
      const object = await f.bucket.get(key, options);
      if (key === keyOf(upload)) {
        observed();
        await barrier;
      }
      return object;
    },
  });
  return { captured, release, storage };
}

test("ZIP 完成审计 ABORT 不留下 passed，原 policy 和结果在下一次真实执行恢复", async () => {
  const upload = await prepared(f, packageBytes());
  await startPackage(f, upload);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_zip_finish BEFORE INSERT ON inspection_events WHEN NEW.state = 'passed' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_ZIP_FINISH'); END",
    )
    .run();
  try {
    await tick(f);
    const failed = (await read(f, upload)).body;
    assert.equal(failed.state, "queued");
    assert.equal(failed.attempts, 1);
    assert.equal(failed.result, null);
    assert.equal(failed.policy, packagePolicy);
  } finally {
    await f.db.prepare("DROP TRIGGER fail_zip_finish").run();
  }
  await dueInspection(f, upload);
  await tick(f);
  const result = (await read(f, upload)).body;
  assert.equal(result.state, "passed");
  assert.equal(result.attempts, 2);
  assert.equal(result.result.fileCount, 2);
  const events = await f.db
    .prepare("SELECT state FROM inspection_events WHERE inspection_id = ? ORDER BY revision")
    .bind(result.id)
    .all();
  assert.deepEqual(
    events.results.map((event) => event.state),
    ["queued", "running", "queued", "running", "passed"],
  );
});

test("ZIP 执行中取消只提交 invalidated，旧对象不会保存多文件 passed 结果", async () => {
  const upload = await prepared(f, packageBytes());
  await startPackage(f, upload);
  const hold = heldGet(upload);
  const pending = scheduledWithStorage(f, hold.storage);
  try {
    await hold.captured;
    assert.equal((await cancel(f, upload)).status, 200);
  } finally {
    hold.release();
  }
  await pending;
  const result = (await read(f, upload)).body;
  assert.equal(result.state, "invalidated");
  assert.equal(result.bindingCurrent, false);
  assert.equal(result.result, null);
});

test("ZIP 过期租约恢复隔离旧执行者，重放不能覆盖结果或重置已消耗次数", async () => {
  const upload = await prepared(f, packageBytes());
  await startPackage(f, upload);
  const hold = heldGet(upload);
  const pending = scheduledWithStorage(f, hold.storage);
  let recovered;
  try {
    await hold.captured;
    await dueInspection(f, upload);
    await tick(f);
    recovered = (await read(f, upload)).body;
    assert.equal(recovered.state, "passed");
    assert.equal(recovered.attempts, 2);
  } finally {
    hold.release();
  }
  await pending;
  assert.deepEqual((await read(f, upload)).body, recovered);
  assert.deepEqual((await startPackage(f, upload)).body, recovered);
});
