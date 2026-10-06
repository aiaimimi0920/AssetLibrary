import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  coreModules,
  denied,
  hypotheticalApproved,
  hypotheticalPublication,
  publicationEvents,
} from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { cancel } from "./upload-fixture.mjs";
import { heldBatch, reviewerConfig, withdraw } from "./version-fixture.mjs";

let f;
let core;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
  core = await coreModules();
});
after(async () => {
  await f?.dispose();
});

test("假设部署准入的真实 D1：并发发布只有一个事实和成功审计，不改审核版本", async () => {
  const { version } = await hypotheticalApproved(f);
  const results = await Promise.all(
    Array.from({ length: 4 }, () => core.publishVersion(f.db, version.id, "user:alice", 2)),
  );
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  const rows = await Promise.all(results.map((r) => r.json()));
  assert.ok(rows.every((r) => r.id === rows[0].id));
  assert.equal(rows[0].bindingCurrent, true);
  assert.deepEqual(await publicationEvents(f, rows[0]), [{ action: "published", revision: 1 }]);
  assert.equal((await f.request("GET", `/v1/versions/${version.id}`)).body.state, "approved");
  assert.equal((await f.request("GET", `/v1/versions/${version.id}`)).body.revision, 2);
  assert.deepEqual((await f.request("GET", `/v1/versions/${version.id}`)).body.publication, {
    id: rows[0].id,
    state: "published",
    revision: 1,
  });
});

test("真实生产 Worker：合成 clean/历史发布/请求或环境开关都不能绕过未验收门禁", async () => {
  const { version, publication } = await hypotheticalPublication(f);
  const publish = await f.request("POST", `/v1/versions/${version.id}/publish`, { revision: 2 });
  assert.equal(publish.status, 409);
  assert.equal(publish.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
  assert.equal(
    (
      await f.request("POST", `/v1/versions/${version.id}/publish`, {
        revision: 2,
        cloudValidated: true,
      })
    ).status,
    400,
  );
  const catalog = await f.request("GET", "/v1/catalog", undefined, { token: "" });
  assert.equal(catalog.status, 503);
  assert.deepEqual(catalog.body, { error: "SCANNER_CLOUD_NOT_VALIDATED" });
  assert.equal(
    (await f.request("GET", "/v1/me/library")).body.error,
    "SCANNER_CLOUD_NOT_VALIDATED",
  );
  assert.equal(
    (await f.request("POST", `/v1/publications/${publication.id}/tickets`, {})).body.error,
    "SCANNER_CLOUD_NOT_VALIDATED",
  );
  assert.equal(
    (await f.request("GET", `/v1/publications/${publication.id}/content`)).body.error,
    "SCANNER_CLOUD_NOT_VALIDATED",
  );
  assert.equal(
    (
      await f.request("GET", `/v1/publications/${publication.id}`, undefined, {
        principal: "user:eve",
      })
    ).status,
    404,
  );
  const { callWithEnv } = await import("./version-fixture.mjs");
  const forged = await callWithEnv(
    f,
    "POST",
    `/v1/versions/${version.id}/publish`,
    { revision: 2 },
    { CLOUD_VALIDATED: true, DISTRIBUTION_ENABLED: true },
    "user:alice",
  );
  assert.equal(forged.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
});

test("发布核心重查 owner/revision/批准/绑定，拒绝过期或畸形扫描事实", async () => {
  const { version, upload } = await hypotheticalApproved(f);
  await denied(core.publishVersion(f.db, version.id, "user:eve", 2));
  await denied(core.publishVersion(f.db, version.id, "user:alice", 1), "REVISION_CONFLICT");
  await f.db
    .prepare(
      "UPDATE inspections SET result = json_set(result, '$.sha256', 'invalid') WHERE upload_id = ?",
    )
    .bind(upload.id)
    .run();
  await denied(core.publishVersion(f.db, version.id, "user:alice", 2), "VERSION_BINDING_CHANGED");
  const stale = await hypotheticalApproved(f);
  await f.db
    .prepare(
      "UPDATE inspections SET result = json_set(result, '$.scan.completedAt', ?, '$.scan.database.updatedAt', ?, '$.scan.expiresAt', ?) WHERE upload_id = ?",
    )
    .bind(Date.now() - 3600000, Date.now() - 3601000, Date.now() - 1, stale.upload.id)
    .run();
  await denied(
    core.publishVersion(f.db, stale.version.id, "user:alice", 2),
    "CONTENT_SCAN_EXPIRED_OR_INVALIDATED",
  );
  const withdrawn = await hypotheticalApproved(f);
  await withdraw(f, withdrawn.version);
  await denied(
    core.publishVersion(f.db, withdrawn.version.id, "user:alice", 3),
    "VERSION_NOT_APPROVED",
  );
});

test("发布预检后的取消竞争在 batch 内拒绝，不留 publication 或发布事件", async () => {
  const { version, upload } = await hypotheticalApproved(f);
  const hold = heldBatch(f);
  const pending = core.publishVersion(hold.db, version.id, "user:alice", 2);
  const assertion = denied(pending, "VERSION_BINDING_CHANGED");
  try {
    await hold.captured;
    await cancel(f, upload);
  } finally {
    hold.release();
  }
  await assertion;
  assert.equal(
    (
      await f.db
        .prepare("SELECT count(*) AS n FROM publications WHERE version_id = ?")
        .bind(version.id)
        .first()
    ).n,
    0,
  );
});

test("发布审计 ABORT 整批回滚，原请求可安全恢复", async () => {
  const { version } = await hypotheticalApproved(f);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_publication BEFORE INSERT ON publication_events BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_PUBLICATION_AUDIT'); END",
    )
    .run();
  try {
    await assert.rejects(core.publishVersion(f.db, version.id, "user:alice", 2));
    assert.equal(
      (
        await f.db
          .prepare("SELECT count(*) AS n FROM publications WHERE version_id = ?")
          .bind(version.id)
          .first()
      ).n,
      0,
    );
  } finally {
    await f.db.prepare("DROP TRIGGER fail_publication").run();
  }
  assert.equal((await core.publishVersion(f.db, version.id, "user:alice", 2)).status, 201);
});

test("真实生产 Worker 下架可在安全延期期间执行，终态/重放不重新发布", async () => {
  const { version, publication } = await hypotheticalPublication(f);
  const path = `/v1/publications/${publication.id}/unlist`;
  assert.equal(
    (await f.request("POST", path, { revision: 1 }, { principal: "user:eve" })).status,
    404,
  );
  const results = await Promise.all(
    Array.from({ length: 3 }, () => f.request("POST", path, { revision: 1 })),
  );
  assert.ok(
    results.every((r) => r.status === 200 && r.body.revision === 2 && r.body.state === "unlisted"),
  );
  assert.deepEqual(await publicationEvents(f, publication), [
    { action: "published", revision: 1 },
    { action: "unlisted", revision: 2 },
  ]);
  await denied(
    core.publishVersion(f.db, version.id, "user:alice", 2),
    "PUBLICATION_STATE_CONFLICT",
  );
  assert.equal((await f.request("POST", path, { revision: 2 })).status, 409);
});

test("下架审计失败回滚，保护性操作没有假成功", async () => {
  const { publication } = await hypotheticalPublication(f);
  await f.db
    .prepare(
      "CREATE TRIGGER fail_unlist BEFORE INSERT ON publication_events WHEN NEW.action = 'unlisted' BEGIN SELECT RAISE(ABORT, 'TEST_ONLY_UNLIST'); END",
    )
    .run();
  try {
    assert.equal(
      (await f.request("POST", `/v1/publications/${publication.id}/unlist`, { revision: 1 }))
        .status,
      503,
    );
    assert.equal((await core.loadPublication(f.db, publication.id)).state, "published");
    assert.equal((await publicationEvents(f, publication)).length, 1);
  } finally {
    await f.db.prepare("DROP TRIGGER fail_unlist").run();
  }
});
