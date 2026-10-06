import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { fixture } from "./fixture.mjs";
import { checkedSoftware, softwarePolicy } from "./software-package-fixture.mjs";
import { createVersion, review, reviewerConfig } from "./version-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
});
after(async () => f?.dispose());

for (const kind of ["capability", "application"])
  test(`${kind} 实际包体、类型绑定、不可变版本与独立审核；生产发布仍拒绝`, async () => {
    const { upload, checked } = await checkedSoftware(f, kind);
    assert.equal(checked.policy, softwarePolicy(kind));
    assert.equal(checked.result.kind, kind);
    assert.equal(checked.result.schema, "neuro-software-package-v1");
    assert.equal(checked.result.fileCount, 2);
    assert.equal(checked.result.files[0].path, "runtime/main.js");
    assert.equal(checked.bindingCurrent, true);
    assert.equal(checked.publicationEligible, false);
    const created = await createVersion(f, upload);
    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.snapshot.kind, kind);
    const approved = await review(f, created.body);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.contentSafety.scanCurrent, true);
    assert.equal(approved.body.contentSafety.cloudValidated, false);
    const published = await f.request("POST", `/v1/versions/${created.body.id}/publish`, {
      revision: approved.body.revision,
    });
    assert.equal(published.status, 409);
    assert.equal(published.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
    assert.equal(await f.db.prepare("SELECT COUNT(*) AS n FROM publications").first("n"), 0);
  });
