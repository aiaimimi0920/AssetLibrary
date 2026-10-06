import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { packageBytes, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { dueInspection, prepared, read } from "./inspection-fixture.mjs";
import {
  assertNotPassed,
  cleanFact,
  jsonFact,
  queuedScan,
  runScanner,
  scanPolicy,
} from "./scanner-fixture.mjs";
import { cancel, sha256, tick } from "./upload-fixture.mjs";
import { createVersion, events, readVersion, review, reviewerConfig } from "./version-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
});
after(async () => {
  await f?.dispose();
});

test("复合策略：相同 ZIP 字节/摘要只调用一次内部扫描，保存 clean，但发布仍受云门禁阻断", async () => {
  const bytes = packageBytes();
  const upload = await queuedScan(f, bytes);
  let calls = 0;
  await runScanner(f, {
    fetch: async (request) => {
      calls++;
      assert.equal(request.url, "http://scanner/scan");
      assert.equal(request.method, "POST");
      assert.equal(request.redirect, "manual");
      assert.equal(request.headers.get("x-object-sha256"), upload.sha256);
      assert.equal(request.headers.get("content-length"), String(bytes.length));
      assert.equal(sha256(Buffer.from(await request.arrayBuffer())), upload.sha256);
      return jsonFact(cleanFact(upload));
    },
  });
  assert.equal(calls, 1);
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, "passed");
  assert.equal(checked.result.scan.sha256, upload.sha256);
  assert.equal(checked.result.fileCount, 2);
  const created = await createVersion(f, upload);
  assert.equal(created.status, 201);
  assert.equal(created.body.contentSafety.scanCurrent, true);
  assert.equal(created.body.contentSafety.cloudValidated, false);
  assert.equal((await review(f, created.body)).status, 200);
  const published = await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
    revision: 2,
  });
  assert.equal(published.status, 409);
  assert.equal(published.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
  assert.deepEqual(
    (await events(f, created.body)).map((event) => event.action),
    ["created", "approved"],
  );
});

test("扫描 binding 重定向只调用一次并取消响应，不跟随 Location 或保存 clean", async () => {
  const upload = await queuedScan(f);
  let calls = 0;
  let cancelled = false;
  await runScanner(f, {
    fetch: async (request) => {
      calls++;
      assert.equal(request.redirect, "manual");
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
        { status: 302, headers: { location: "https://redirect.invalid/scan" } },
      );
    },
  });
  const checked = await assertNotPassed(f, upload);
  assert.equal(checked.attempts, 1);
  assert.equal(calls, 1);
  assert.equal(cancelled, true);
  await cancel(f, upload);
});

test("恶意命中为终态 rejected；格式拒绝在扫描前发生", async () => {
  const upload = await queuedScan(f);
  await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload, { verdict: "infected" })) });
  const checked = await assertNotPassed(f, upload, "rejected");
  assert.equal(checked.error, "SCANNER_CONTENT_REJECTED");
  const invalid = await queuedScan(f, Buffer.from("not a zip"));
  let calls = 0;
  await runScanner(f, {
    fetch: async () => {
      calls++;
      throw new Error();
    },
  });
  await assertNotPassed(f, invalid, "rejected");
  assert.equal(calls, 0);
});

test("缺失/不可用 scanner 沿用三次 budget，无隐藏重试或政策升级", async () => {
  const upload = await queuedScan(f);
  let calls = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dueInspection(f, upload);
    await runScanner(f, {
      fetch: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
    });
    assert.equal(
      (await assertNotPassed(f, upload, attempt === 3 ? "failed" : "queued")).attempts,
      attempt,
    );
  }
  await runScanner(f, {
    fetch: async () => {
      calls++;
      throw new Error();
    },
  });
  assert.equal(calls, 3);
  const missing = await queuedScan(f);
  await runScanner(f);
  await assertNotPassed(f, missing);
  // 避免下一例的 due 集合混入本测试待重试的对象。
  await cancel(f, missing);
  const old = await prepared(f, packageBytes());
  await startPackage(f, old);
  await tick(f);
  assert.equal((await read(f, old)).body.state, "passed");
  assert.equal((await startPackage(f, old, scanPolicy)).body.error, "INSPECTION_POLICY_CONFLICT");
});

test("错误身份、过期库/扫描、重放时间、错误引擎或扩展字段不得产生 passed", async () => {
  const now = Date.now();
  const changes = [
    { sha256: "b".repeat(64) },
    { size: 1 },
    { engineVersion: "1.5.3" },
    { database: { sha256: "a".repeat(64), dailyVersion: 1, updatedAt: now - 172800001 } },
    { database: { sha256: "not a digest", dailyVersion: 1, updatedAt: now } },
    { expiresAt: now - 1 },
    { completedAt: now - 100000 },
    { expiresAt: now + 172800000 },
    { extra: true },
    { protocol: "unknown" },
  ];
  for (const change of changes) {
    const upload = await queuedScan(f);
    await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload, change)) });
    await assertNotPassed(f, upload);
    await cancel(f, upload);
  }
});

test("超大/错误 media type 响应取消流；坏 JSON 失败关闭", async () => {
  for (const [content, media] of [
    ["x".repeat(4097), "application/json"],
    ["{}", "text/plain"],
  ]) {
    const upload = await queuedScan(f);
    let cancelled = false;
    await runScanner(f, {
      fetch: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.from(content));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": media } },
        ),
    });
    await assertNotPassed(f, upload);
    assert.equal(cancelled, true);
    await cancel(f, upload);
  }
  const upload = await queuedScan(f);
  await runScanner(f, {
    fetch: async () => new Response("{bad", { headers: { "content-type": "application/json" } }),
  });
  await assertNotPassed(f, upload);
  await cancel(f, upload);
});

test("扫描持有字节时取消上传，晚到 clean 只能提交 invalidated", async () => {
  const upload = await queuedScan(f);
  let observed, release;
  const captured = new Promise((resolve) => {
    observed = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const pending = runScanner(f, {
    fetch: async () => {
      observed();
      await barrier;
      return jsonFact(cleanFact(upload));
    },
  });
  try {
    await captured;
    await cancel(f, upload);
  } finally {
    release();
  }
  await pending;
  await assertNotPassed(f, upload, "invalidated");
});

test("历史 passed 和独立批准保留；当前 scan 过期后不再有效，publish 保持拒绝", async () => {
  const upload = await queuedScan(f);
  await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload)) });
  const created = await createVersion(f, upload);
  assert.equal(created.status, 201);
  await review(f, created.body);
  const row = await f.db
    .prepare("SELECT result FROM inspections WHERE upload_id = ?")
    .bind(upload.id)
    .first();
  const result = JSON.parse(row.result);
  const now = Date.now();
  result.scan.completedAt = now - 3600000;
  result.scan.database.updatedAt = now - 3601000;
  result.scan.expiresAt = now - 1;
  await f.db
    .prepare("UPDATE inspections SET result = ? WHERE upload_id = ?")
    .bind(JSON.stringify(result), upload.id)
    .run();
  const version = (await readVersion(f, created.body)).body;
  assert.equal(version.state, "approved");
  assert.equal(version.contentSafety.scanCurrent, false);
  assert.equal((await read(f, upload)).body.state, "passed");
  assert.equal(
    (await f.request("POST", `/v1/versions/${version.id}/publish`, { revision: 2 })).body.error,
    "CONTENT_SCAN_EXPIRED_OR_INVALIDATED",
  );
  assert.deepEqual(
    (await events(f, version)).map((event) => event.action),
    ["created", "approved"],
  );
});

test("复合检查完成审计 ABORT 回滚 clean 事实，恢复后第二次领取才提交 passed", async () => {
  const upload = await queuedScan(f);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_scan_audit BEFORE INSERT ON inspection_events WHEN NEW.state = 'passed' BEGIN SELECT RAISE(ABORT, 'TEST_SCAN_AUDIT'); END",
    )
    .run();
  try {
    await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload)) });
    const failed = await assertNotPassed(f, upload);
    assert.equal(failed.attempts, 1);
    const event = await f.db
      .prepare(
        "SELECT count(*) AS n FROM inspection_events WHERE inspection_id = ? AND state = 'passed'",
      )
      .bind(failed.id)
      .first();
    assert.equal(event.n, 0);
  } finally {
    await f.db.prepare("DROP TRIGGER fail_scan_audit").run();
  }
  await dueInspection(f, upload);
  await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload)) });
  const checked = (await read(f, upload)).body;
  assert.equal(checked.state, "passed");
  assert.equal(checked.attempts, 2);
});

test("Schema 拒绝缺失/错误 clean 身份；畸形历史数据库事实不会显示当前有效扫描", async () => {
  const upload = await queuedScan(f);
  await runScanner(f, { fetch: async () => jsonFact(cleanFact(upload)) });
  const created = await createVersion(f, upload);
  await review(f, created.body);
  const row = await f.db
    .prepare("SELECT result FROM inspections WHERE upload_id = ?")
    .bind(upload.id)
    .first();
  for (const scan of [
    null,
    { verdict: "clean" },
    cleanFact(upload, { sha256: "b".repeat(64) }),
    cleanFact(upload, { verdict: "infected" }),
  ]) {
    const invalid = { ...JSON.parse(row.result), scan };
    await assert.rejects(
      f.db
        .prepare("UPDATE inspections SET result = ? WHERE upload_id = ?")
        .bind(JSON.stringify(invalid), upload.id)
        .run(),
      /CHECK constraint/,
    );
  }
  const result = JSON.parse(row.result);
  result.scan.database.sha256 = "invalid";
  await f.db
    .prepare("UPDATE inspections SET result = ? WHERE upload_id = ?")
    .bind(JSON.stringify(result), upload.id)
    .run();
  const queried = await readVersion(f, created.body);
  assert.equal(queried.status, 200);
  assert.equal(queried.body.state, "approved");
  assert.equal(queried.body.contentSafety.scan, null);
  assert.equal(queried.body.contentSafety.scanCurrent, false);
});
