import assert from "node:assert/strict";
import { test } from "node:test";
import { assessScannerRelease } from "../scripts/scanner-release-policy.mjs";
import { imageInventory } from "./scanner-image-fixture.mjs";
import { releaseDatabase, runtimeFixture } from "./scanner-runtime-fixture.mjs";

const now = Date.UTC(2026, 9, 5, 3);
const image = `sha256:${"a".repeat(64)}`;
function input() {
  return {
    runtime: runtimeFixture(releaseDatabase(now - 3600000), now, image),
    report: {
      SchemaVersion: 2,
      Trivy: { Version: "0.75.0" },
      ArtifactType: "container_image",
      Metadata: { ImageID: image, OS: { Family: "alpine", Name: "3.24.2" } },
      CreatedAt: new Date(now).toISOString(),
      Results: [imageInventory()],
    },
    vulnerabilityDatabase: { Version: 2, UpdatedAt: new Date(now - 3600000).toISOString() },
  };
}
const item = (value, name) => value.runtime.cases.find((entry) => entry.name === name);
const business = (value) => item(value, "real-av-version-approval-publish-blocked");

test("完整十项合成合同仅取得候选资格；顺序只约束断开后的恢复", () => {
  const value = input();
  assert.equal(assessScannerRelease(value, now).candidateEligible, true);
  value.runtime.cases.splice(0, 2, ...value.runtime.cases.slice(0, 2).reverse());
  assert.equal(assessScannerRelease(value, now).publicationEligible, false);
});

test("十条记录不能替代十项必要场景，占位、重复、未知和缺失均拒绝", () => {
  for (let index = 0; index < input().runtime.cases.length; index++) {
    const value = input();
    value.runtime.cases.splice(index, 1);
    assert.throws(() => assessScannerRelease(value, now));
  }
  for (const mutate of [
    (v) => {
      v.runtime.cases[2] = { name: "case-placeholder" };
    },
    (v) => {
      v.runtime.cases[2] = structuredClone(v.runtime.cases[0]);
    },
    (v) => {
      v.runtime.cases[2].name = "unknown-scenario";
    },
    (v) => {
      v.runtime.cases.pop();
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessScannerRelease(value, now));
  }
});

test("EICAR、无 UTF8 标志、超限拒绝和扫描身份必须逐项复核", () => {
  for (const name of ["eicar-stored-entry", "eicar-last-entry-deflate", "clean-ascii-no-utf8-flag"])
    for (const mutate of [
      (c) => {
        c.status = 503;
      },
      (c) => {
        c.body.verdict = c.body.verdict === "clean" ? "infected" : "clean";
      },
      (c) => {
        c.body.database.sha256 = "b".repeat(64);
      },
      (c) => {
        c.body.database.dailyVersion++;
      },
      (c) => {
        c.body.size++;
      },
      (c) => {
        c.body.sha256 = "b".repeat(64);
      },
      (c) => {
        c.body.engineVersion = "0.1";
      },
      (c) => {
        c.body.expiresAt = now;
      },
    ]) {
      const value = input();
      mutate(item(value, name));
      assert.throws(() => assessScannerRelease(value, now));
    }
  for (const mutate of [
    (c) => {
      c.status = 503;
    },
    (c) => {
      c.status = 200;
    },
    (c) => {
      c.body.error = "SCANNER_UNAVAILABLE";
    },
  ]) {
    const value = input();
    mutate(item(value, "expanded-file-limit"));
    assert.throws(() => assessScannerRelease(value, now));
  }
});

test("实际业务链必须记录独立批准、当前对象绑定及零发布副作用", () => {
  for (const mutate of [
    (c) => {
      c.version.state = "pending_review";
    },
    (c) => {
      c.version.review = null;
    },
    (c) => {
      c.version.review.reviewer = "user:owner";
    },
    (c) => {
      c.version.snapshot.sha256 = "b".repeat(64);
    },
    (c) => {
      c.version.snapshot.uploadId = "other-upload";
    },
    (c) => {
      c.version.snapshot.inspection.revision++;
    },
    (c) => {
      c.approvalStatus = 409;
    },
    (c) => {
      c.publicationStatus = 200;
    },
    (c) => {
      c.published.error = "VERSION_NOT_APPROVED";
    },
    (c) => {
      c.versionEvents.push({ action: "published", revision: 3 });
    },
    (c) => {
      c.versionAfterPublication.revision++;
    },
    (c) => {
      delete c.versionAfterPublication;
    },
    (c) => {
      c.version.contentSafety.scan = c.versionAfterPublication.contentSafety.scan = null;
    },
    (c) => {
      c.version.contentSafety.scanCurrent =
        c.versionAfterPublication.contentSafety.scanCurrent = false;
    },
    (c) => {
      c.version.contentSafety.cloudValidated =
        c.versionAfterPublication.contentSafety.cloudValidated = true;
    },
    (c) => {
      delete c.inspection.checkedIdentity.etag;
      delete c.version.snapshot.etag;
    },
    (c) => {
      c.versionEvents[1].actor = "user:owner";
    },
    (c) => {
      c.inspection.result.scan.database.sha256 = "b".repeat(64);
    },
    (c) => {
      c.inspection.result.bytesRead++;
    },
    (c) => {
      c.inspection.bindingCurrent = false;
    },
    (c) => {
      c.inspection.publicationEligible = true;
    },
  ]) {
    const value = input();
    mutate(business(value));
    assert.throws(() => assessScannerRelease(value, now));
  }
});

test("格式拒绝、像素检测边界和主动断开后的恢复不能被失败占位替代", () => {
  for (const mutate of [
    (v) => {
      item(v, "eicar-disguised-as-png-format-rejected").scannerCalls = 1;
    },
    (v) => {
      item(v, "eicar-disguised-as-png-format-rejected").inspection.error = "OTHER";
    },
    (v) => {
      item(v, "eicar-disguised-as-png-format-rejected").inspection.result = {};
    },
    (v) => {
      item(v, "png-pixel-eicar-not-a-detection-proof").inspection.state = "queued";
    },
    (v) => {
      item(v, "png-pixel-eicar-not-a-detection-proof").limitation = "";
    },
    (v) => {
      item(v, "http-disconnect").clientAborted = false;
    },
    (v) => {
      item(v, "http-disconnect").status = 200;
    },
    (v) => {
      v.runtime.cases.reverse();
    },
    (v) => {
      v.runtime.actual.scanningProcesses = [42];
    },
    (v) => {
      delete v.runtime.actual.scanningProcesses;
    },
  ]) {
    const value = input();
    mutate(value);
    assert.throws(() => assessScannerRelease(value, now));
  }
});
