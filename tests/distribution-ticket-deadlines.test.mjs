import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  coreModules,
  denied,
  hypotheticalPublication,
  ticketFor,
} from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { releaseFixture } from "./scanner-deployment-fixture.mjs";
import { reviewerConfig } from "./version-fixture.mjs";

let f;
let core;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
  core = await coreModules();
});
after(async () => await f?.dispose());

function heldStatement(db, pattern, method, afterRead = false) {
  let observe;
  let resume;
  const captured = new Promise((resolve) => {
    observe = resolve;
  });
  const barrier = new Promise((resolve) => {
    resume = resolve;
  });
  return {
    captured,
    release: () => resume(),
    db: {
      prepare(sql) {
        const statement = db.prepare(sql);
        if (!pattern.test(sql)) return statement;
        return {
          bind(...args) {
            const bound = statement.bind(...args);
            return {
              async [method]() {
                const result = afterRead ? await bound[method]() : undefined;
                observe();
                await barrier;
                return afterRead ? result : bound[method]();
              },
            };
          },
        };
      },
    },
  };
}

async function expireWhileHeld(hold, pending, expiresAt) {
  const assertion = denied(pending);
  try {
    await hold.captured;
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, expiresAt - Date.now()) + 60));
  } finally {
    hold.release();
  }
  await assertion;
}

for (const afterRead of [false, true]) {
  test(`签发在 D1 ${afterRead ? "写入后响应等待" : "执行前等待"}期间过期，不返回票据`, async () => {
    const { publication } = await hypotheticalPublication(f);
    const row = await core.loadPublication(f.db, publication.id);
    const scan = core.publicationScan(row);
    const release = {
      ...releaseFixture().release,
      database: scan.database,
      validatedAt: scan.completedAt - 1,
      expiresAt: Date.now() + 1000,
    };
    const hold = heldStatement(f.db, /INSERT INTO download_tickets/, "run", afterRead);
    await expireWhileHeld(
      hold,
      core.issueTicket(hold.db, publication.id, "user:alice", release),
      release.expiresAt,
    );
    const count = await f.db
      .prepare("SELECT count(*) AS n FROM download_tickets WHERE publication_id = ?")
      .bind(publication.id)
      .first();
    // 已在有效期内写入的摘要留给既有有界清理，不返回 token、不额外回滚写操作。
    assert.equal(count.n, afterRead ? 1 : 0);
  });
}

for (const afterRead of [false, true]) {
  test(`票据在 D1 ${afterRead ? "读取后响应等待" : "执行前等待"}期间过期，拒绝下载授权`, async () => {
    const { publication } = await hypotheticalPublication(f);
    const ticket = await ticketFor(f, publication);
    const expiresAt = Date.now() + 1000;
    await f.db
      .prepare("UPDATE download_tickets SET expires_at = ? WHERE publication_id = ?")
      .bind(expiresAt, publication.id)
      .run();
    const hold = heldStatement(f.db, /JOIN download_tickets/, "first", afterRead);
    await expireWhileHeld(
      hold,
      core.authorizeTicket(hold.db, publication.id, "user:alice", ticket.ticket),
      expiresAt,
    );
  });
}
