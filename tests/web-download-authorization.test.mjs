import assert from "node:assert/strict";
import test from "node:test";
import { contentRequest, coreModules } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { checkedSoftware, softwareBytes } from "./software-package-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";
import { browserModules } from "./web-client-fixture.mjs";

async function scenario(action) {
  const f = await fixture({ reviewers: reviewerConfig });
  const original = globalThis.fetch;
  let browser;
  let transfer;
  try {
    const core = await coreModules();
    const bytes = softwareBytes("application", {
      files: [{ path: "data/sample.bin", bytes: Buffer.alloc(600000, 42) }],
    });
    const { upload } = await checkedSoftware(f, "application", bytes);
    const created = await createVersion(f, upload);
    assert.equal(created.status, 201);
    const approved = await review(f, created.body);
    assert.equal(approved.status, 200);
    // 仅在宿主假设准入，复用真实 D1/R2 核心；不向生产 HTTP 加测试开关。
    const published = await core.publishVersion(
      f.db,
      approved.body.id,
      "user:alice",
      approved.body.revision,
    );
    assert.equal(published.status, 201);
    const publication = await published.json();
    const grant = `/v1/publications/${publication.id}/grants/user:bob`;
    assert.equal((await f.request("PUT", grant, { revision: 0 })).status, 200);
    browser = await browserModules();
    browser.api.setCredential("synthetic-local-bob");
    transfer = browser.resume.createDownloadTransfer();
    let segments = 0;
    let tickets = 0;
    let interrupted = false;
    let revoked = false;
    const issued = [];
    const accepted = [];
    async function revoke() {
      assert.equal((await f.request("DELETE", grant, { revision: 1 })).status, 200);
      revoked = true;
    }
    globalThis.fetch = async (path, options) => {
      assert.equal(options.headers.Authorization, "Bearer synthetic-local-bob");
      assert.equal(options.credentials, "omit");
      assert.equal(options.redirect, "error");
      assert.equal(options.cache, "no-store");
      try {
        if (options.method === "POST") {
          assert.equal(path, `/v1/publications/${publication.id}/tickets`);
          tickets += 1;
          const response = await core.issueTicket(f.db, publication.id, "user:bob");
          const ticket = await response.json();
          issued.push(ticket);
          return Response.json(ticket, { status: response.status });
        }
        segments += 1;
        if (segments === 2 && action !== "revoke-between-segments" && !interrupted) {
          interrupted = true;
          throw new TypeError("INJECTED_TRANSPORT_FAILURE");
        }
        if (segments === 2 && action === "revoke-between-segments") await revoke();
        assert.equal(path, `/v1/publications/${publication.id}/content`);
        const response = await core.downloadContent(
          contentRequest(
            publication,
            { ticket: options.headers["X-Download-Ticket"] },
            {
              headers: {
                range: options.headers.Range,
                ...(options.headers["If-Range"] ? { "if-range": options.headers["If-Range"] } : {}),
              },
              signal: options.signal,
            },
          ),
          f.env,
          publication.id,
          "user:bob",
        );
        assert.equal(response.status, 206);
        const received = Buffer.from(await response.arrayBuffer());
        const [start, end] = options.headers.Range.slice(6).split("-").map(Number);
        assert.deepEqual(received, bytes.subarray(start, end + 1));
        accepted.push(options.headers.Range);
        return new Response(received, { status: response.status, headers: response.headers });
      } catch (error) {
        if (error.code === "NOT_FOUND")
          return Response.json({ error: error.code }, { status: 404 });
        throw error;
      }
    };
    if (action === "revoke-between-segments") {
      await assert.rejects(transfer.fetch(publication), /NOT_FOUND/);
      assert.equal(revoked, true);
      assert.equal(tickets, 1);
      assert.equal(segments, 2);
    } else {
      await assert.rejects(transfer.fetch(publication), /INJECTED_TRANSPORT_FAILURE/);
      assert.equal(transfer.snapshot().offset, 262144);
      assert.equal(transfer.snapshot().resumable, true);
      if (action === "unlist-before-resume") {
        assert.equal(
          (await core.unlistPublication(f.db, publication.id, "user:alice", 1)).status,
          200,
        );
      } else await revoke();
      await assert.rejects(transfer.fetch(null, undefined, true), /NOT_FOUND/);
      assert.equal(tickets, 2);
      assert.equal(segments, 2);
    }
    assert.deepEqual(accepted, ["bytes=0-262143"]);
    assert.equal(transfer.snapshot(), null);
    await assert.rejects(transfer.fetch(null, undefined, true), /NO_RESUMABLE_DOWNLOAD/);
    // 再授予只允许新票据；历史票据不会因授权恢复复活。
    if (revoked) {
      assert.equal((await f.request("PUT", grant, { revision: 2 })).status, 200);
      await assert.rejects(
        core.authorizeTicket(f.db, publication.id, "user:bob", issued[0].ticket),
        { code: "NOT_FOUND" },
      );
      const result = await transfer.fetch(publication);
      assert.deepEqual(Buffer.from(await result.blob.arrayBuffer()), bytes);
      assert.notEqual(issued.at(-1).ticket, issued[0].ticket);
      assert.equal(transfer.snapshot(), null);
    }
    assert.equal(
      (
        await f.request(
          "POST",
          `/v1/publications/${publication.id}/tickets`,
          {},
          { principal: "user:bob" },
        )
      ).body.error,
      "SCANNER_CLOUD_NOT_VALIDATED",
    );
  } finally {
    transfer?.dispose();
    browser?.api.stopRequests();
    globalThis.fetch = original;
    await f.dispose();
  }
}

for (const action of ["revoke-between-segments", "revoke-before-resume", "unlist-before-resume"]) {
  test(`Web 与真实 D1/R2 联合验证 ${action} 拒绝后续字节并清空缓存`, () => scenario(action));
}
