import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  contentRequest,
  coreModules,
  denied,
  hypotheticalPublication,
  ticketFor,
} from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { cancel, keyOf } from "./upload-fixture.mjs";
import { reviewerConfig, withdraw } from "./version-fixture.mjs";

let f;
let core;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
  core = await coreModules();
});
after(async () => {
  await f?.dispose();
});

function heldObject(bucket) {
  let observe;
  let release;
  let cancelled = false;
  const captured = new Promise((resolve) => {
    observe = resolve;
  });
  const barrier = new Promise((resolve) => {
    release = resolve;
  });
  const storage = new Proxy(bucket, {
    get(target, name) {
      if (name === "get")
        return async (...args) => {
          const object = await target.get(...args);
          assert.ok(object?.body);
          const original = object.body;
          const body = new ReadableStream({
            cancel(reason) {
              cancelled = true;
              return original.cancel(reason);
            },
          });
          observe();
          await barrier;
          return new Proxy(object, {
            get(value, field) {
              return field === "body" ? body : Reflect.get(value, field);
            },
          });
        };
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage, captured, release: () => release(), cancelled: () => cancelled };
}

test("R2 GET 等待期间下架/取消/撤销发生，第二次 D1 检查拒绝并关闭已取得的流", async () => {
  for (const action of ["unlist", "cancel", "revoke"]) {
    const { publication, upload } = await hypotheticalPublication(f);
    const actor = action === "revoke" ? "user:bob" : "user:alice";
    if (actor === "user:bob")
      await core.changeGrant(f.db, publication.id, "user:alice", actor, 0, "active");
    const ticket = await ticketFor(f, publication, actor);
    const hold = heldObject(f.bucket);
    const pending = core.downloadContent(
      contentRequest(publication, ticket),
      { ...f.env, QUARANTINE: hold.storage },
      publication.id,
      actor,
    );
    const assertion = denied(pending);
    try {
      await hold.captured;
      if (action === "unlist") await core.unlistPublication(f.db, publication.id, "user:alice", 1);
      else if (action === "cancel") await cancel(f, upload);
      else await core.changeGrant(f.db, publication.id, "user:alice", actor, 1, "revoked");
    } finally {
      hold.release();
    }
    await assertion;
    assert.equal(hold.cancelled(), true, action);
  }
});

test("版本撤回、资源修改/删除或扫描失效均拒绝历史票据", async () => {
  for (const action of ["withdraw", "rename", "delete", "scan", "malformed"]) {
    const { publication, version, upload } = await hypotheticalPublication(f);
    const ticket = await ticketFor(f, publication);
    if (action === "withdraw") await withdraw(f, version);
    else if (action === "rename")
      await f.request("PATCH", `/v1/resources/${upload.resourceId}`, {
        revision: 1,
        title: "修改后的标题",
      });
    else if (action === "delete")
      await f.request("DELETE", `/v1/resources/${upload.resourceId}`, { revision: 1 });
    else if (action === "scan")
      await f.db
        .prepare(
          "UPDATE inspections SET result = json_set(result, '$.scan.database.dailyVersion', 2) WHERE upload_id = ?",
        )
        .bind(upload.id)
        .run();
    else
      await f.db
        .prepare("UPDATE publications SET scan_result = '{}' WHERE id = ?")
        .bind(publication.id)
        .run();
    await denied(core.authorizeTicket(f.db, publication.id, "user:alice", ticket.ticket));
    await denied(core.publicDetail(f.db, publication.id));
  }
});

test("R2 对象消失/覆盖/伪造 custom metadata 不能交付不匹配字节", async () => {
  for (const action of ["missing", "overwrite", "metadata"]) {
    const { publication, upload } = await hypotheticalPublication(f);
    const ticket = await ticketFor(f, publication);
    if (action === "missing") await f.bucket.delete(keyOf(upload));
    else
      await f.bucket.put(
        keyOf(upload),
        Buffer.alloc(upload.size),
        action === "metadata"
          ? {
              customMetadata: { sha256: upload.sha256 },
            }
          : {},
      );
    await denied(
      core.downloadContent(
        contentRequest(publication, ticket),
        f.env,
        publication.id,
        "user:alice",
      ),
      "DISTRIBUTION_OBJECT_CHANGED",
    );
  }
});

test("撤销不承诺收回已传字节：已开始响应可以结束，之后的新请求/HEAD 拒绝", async () => {
  const { publication, bytes } = await hypotheticalPublication(f);
  const ticket = await ticketFor(f, publication);
  const response = await core.downloadContent(
    contentRequest(publication, ticket),
    f.env,
    publication.id,
    "user:alice",
  );
  await core.unlistPublication(f.db, publication.id, "user:alice", 1);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
  await denied(
    core.downloadContent(
      contentRequest(publication, ticket, { method: "HEAD" }),
      f.env,
      publication.id,
      "user:alice",
    ),
  );
});

test("下载 stream 消费取消/请求中止/读取失败均主动清理上游 reader", async () => {
  for (const action of ["cancel", "abort", "error"]) {
    let cancelled = 0;
    let pull;
    const body = new ReadableStream({
      pull(controller) {
        if (action === "error") controller.error(new Error("TEST_ONLY_READ_FAILURE"));
        else
          return new Promise((resolve) => {
            pull = resolve;
          });
      },
      cancel() {
        cancelled++;
        pull?.();
      },
    });
    const control = new AbortController();
    const stream = core.downloadStream(body, control.signal);
    if (action === "cancel") await stream.cancel();
    else {
      const reader = stream.getReader();
      const read = assert.rejects(
        reader.read(),
        action === "abort" ? /DOWNLOAD_ABORTED/ : /TEST_ONLY_READ_FAILURE/,
      );
      if (action === "abort") control.abort();
      await read;
      await new Promise((resolve) => setTimeout(resolve, 10));
      reader.releaseLock();
    }
    assert.equal(body.locked, false, action);
    if (action !== "error") assert.equal(cancelled, 1, action);
  }
});

test("下载预先中止不访问 R2，R2 等待中中止取消取得流", async () => {
  const { publication } = await hypotheticalPublication(f);
  const ticket = await ticketFor(f, publication);
  const pre = new AbortController();
  pre.abort();
  await denied(
    core.downloadContent(
      contentRequest(publication, ticket, { signal: pre.signal }),
      f.env,
      publication.id,
      "user:alice",
    ),
    "DOWNLOAD_ABORTED",
  );
  const control = new AbortController();
  const hold = heldObject(f.bucket);
  const pending = core.downloadContent(
    contentRequest(publication, ticket, { signal: control.signal }),
    { ...f.env, QUARANTINE: hold.storage },
    publication.id,
    "user:alice",
  );
  const assertion = denied(pending, "DOWNLOAD_ABORTED");
  try {
    await hold.captured;
    control.abort();
  } finally {
    hold.release();
  }
  await assertion;
  assert.equal(hold.cancelled(), true);
});
