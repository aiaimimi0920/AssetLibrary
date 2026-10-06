import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { contentRequest, coreModules, denied, ticketFor } from "./distribution-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { checkedSoftware, softwarePolicy } from "./software-package-fixture.mjs";
import { sha256 } from "./upload-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

let f, core;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
  core = await coreModules();
});
after(async () => f?.dispose());

for (const kind of ["capability", "application"])
  test(`${kind} 假设准入：授权同包下载、Range、撤销、下架；普通 HTTP 始终硬拒绝`, async () => {
    const { upload, bytes } = await checkedSoftware(f, kind);
    const created = await createVersion(f, upload);
    assert.equal(created.status, 201);
    const approved = await review(f, created.body);
    assert.equal(approved.status, 200);
    // 仅测试宿主直接调用同一个业务核心；不为 Worker 添加准入开关。
    const published = await core.publishVersion(
      f.db,
      created.body.id,
      "user:alice",
      approved.body.revision,
    );
    assert.equal(published.status, 201);
    const publication = await published.json();
    assert.equal(publication.kind, kind);
    assert.equal(publication.policy, softwarePolicy(kind));
    assert.equal(
      (await f.request("POST", `/v1/publications/${publication.id}/tickets`, {})).body.error,
      "SCANNER_CLOUD_NOT_VALIDATED",
    );
    await denied(core.issueTicket(f.db, publication.id, "user:bob"));
    const grant = `/v1/publications/${publication.id}/grants/user:bob`;
    assert.equal((await f.request("PUT", grant, { revision: 0 })).status, 200);
    const ticket = await ticketFor(f, publication, "user:bob");
    for (const partial of [false, true]) {
      const response = await core.downloadContent(
        contentRequest(publication, ticket, {
          headers: partial ? { range: "bytes=3-17" } : {},
        }),
        f.env,
        publication.id,
        "user:bob",
      );
      assert.equal(response.status, partial ? 206 : 200);
      assert.equal(response.headers.get("content-type"), "application/zip");
      assert.equal(
        response.headers.get("content-disposition"),
        `attachment; filename="package-${publication.versionId}.zip"`,
      );
      const actual = Buffer.from(await response.arrayBuffer());
      assert.deepEqual(actual, partial ? bytes.subarray(3, 18) : bytes);
      if (!partial) assert.equal(sha256(actual), publication.sha256);
    }
    const library = await (
      await core.listPublications(f.db, new URL("http://local/v1/me/library"), "user:bob")
    ).json();
    assert.equal(library.items.find((item) => item.id === publication.id).kind, kind);
    assert.equal((await f.request("DELETE", grant, { revision: 1 })).status, 200);
    await denied(
      core.downloadContent(
        contentRequest(publication, ticket, { headers: { range: "bytes=3-17" } }),
        f.env,
        publication.id,
        "user:bob",
      ),
    );
    assert.equal((await f.request("PUT", grant, { revision: 2 })).status, 200);
    await denied(core.authorizeTicket(f.db, publication.id, "user:bob", ticket.ticket));
    const fresh = await ticketFor(f, publication, "user:bob");
    assert.equal((await core.unlistPublication(f.db, publication.id, "user:alice", 1)).status, 200);
    await denied(
      core.downloadContent(contentRequest(publication, fresh), f.env, publication.id, "user:bob"),
    );
  });
