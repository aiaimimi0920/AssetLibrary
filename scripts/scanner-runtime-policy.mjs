import assert from "node:assert/strict";

const names = [
  "clean-two-png",
  "clean-ascii-no-utf8-flag",
  "eicar-stored-entry",
  "eicar-last-entry-deflate",
  "expanded-file-limit",
  "png-pixel-eicar-not-a-detection-proof",
  "eicar-disguised-as-png-format-rejected",
  "real-av-version-approval-publish-blocked",
  "http-disconnect",
  "clean-after-disconnect",
];
const digest = /^[0-9a-f]{64}$/;

function scanFact(fact, identity, database, verdict, now) {
  assert.equal(fact?.protocol, "neuro-clamav-v1", "RUNTIME_SCAN_PROTOCOL_INVALID");
  assert.equal(fact.verdict, verdict, "RUNTIME_SCAN_VERDICT_INVALID");
  assert.equal(fact.engineVersion, "1.5.4", "RUNTIME_SCAN_ENGINE_INVALID");
  assert.match(identity.sha256, digest, "RUNTIME_INPUT_DIGEST_MISSING");
  assert(Number.isSafeInteger(identity.size) && identity.size > 0 && identity.size <= 8388608);
  assert.equal(fact.sha256, identity.sha256, "RUNTIME_SCAN_INPUT_MISMATCH");
  assert.equal(fact.size, identity.size, "RUNTIME_SCAN_SIZE_MISMATCH");
  assert.deepEqual(
    fact.database,
    {
      sha256: database.sha256,
      dailyVersion: database.dailyVersion,
      updatedAt: database.updatedAt,
    },
    "LOADED_DATABASE_MISMATCH",
  );
  assert(
    Number.isSafeInteger(fact.completedAt) &&
      fact.completedAt > 0 &&
      fact.completedAt <= now + 5000,
  );
  assert(
    Number.isSafeInteger(fact.expiresAt) &&
      fact.expiresAt > now &&
      fact.expiresAt > fact.completedAt,
  );
  assert(fact.expiresAt <= fact.completedAt + 86400000);
  assert(fact.expiresAt <= database.updatedAt + 172800000);
  assert(database.updatedAt <= fact.completedAt + 300000);
}

function inspectionFact(inspection, fileCount, database, now) {
  assert.equal(inspection?.policy, "art-zip-clamav-v1", "RUNTIME_INSPECTION_POLICY_INVALID");
  assert.equal(inspection.state, "passed", "RUNTIME_INSPECTION_FAILED");
  assert.equal(inspection.bindingCurrent, true, "RUNTIME_INSPECTION_BINDING_CHANGED");
  assert.equal(inspection.publicationEligible, false, "RUNTIME_PUBLICATION_GATE_CHANGED");
  assert.equal(inspection.error, null, "RUNTIME_INSPECTION_ERROR");
  assert.equal(inspection.result?.format, "zip", "RUNTIME_ART_RESULT_INVALID");
  assert.equal(inspection.result.schema, "neuro-art-package-v1");
  assert.equal(inspection.result.fileCount, fileCount, "RUNTIME_ART_FILE_COUNT_INVALID");
  assert.equal(inspection.result.files?.length, fileCount);
  assert(inspection.result.files.every((file) => file.mediaType === "image/png"));
  const identity = inspection.checkedIdentity;
  for (const value of [inspection.id, inspection.uploadId, identity?.etag])
    assert(typeof value === "string" && value.length > 0 && value.length <= 128);
  assert(Number.isSafeInteger(inspection.revision) && inspection.revision > 0);
  assert(Number.isSafeInteger(identity.uploadRevision) && identity.uploadRevision > 0);
  assert.equal(inspection.result.sha256, identity?.sha256, "RUNTIME_RESULT_INPUT_MISMATCH");
  assert.equal(inspection.result.bytesRead, identity?.size, "RUNTIME_RESULT_SIZE_MISMATCH");
  scanFact(inspection.result.scan, identity, database, "clean", now);
}

function versionFact(item) {
  assert.equal(item.creationStatus, 201, "RUNTIME_VERSION_CREATION_FAILED");
  assert.equal(item.approvalStatus, 200, "RUNTIME_VERSION_APPROVAL_FAILED");
  assert.equal(item.publicationStatus, 409, "RUNTIME_PUBLICATION_NOT_REJECTED");
  assert.equal(item.published?.error, "SCANNER_CLOUD_NOT_VALIDATED");
  const version = item.version;
  assert.equal(version?.state, "approved", "RUNTIME_VERSION_NOT_APPROVED");
  assert.equal(version.revision, 2);
  assert.equal(version.bindingCurrent, true);
  assert.equal(version.publicationEligible, false);
  assert.equal(version.review?.decision, "approved");
  assert(typeof version.review.reviewer === "string" && version.review.reviewer.length > 0);
  assert.deepEqual(
    version.contentSafety?.scan,
    item.inspection.result.scan,
    "RUNTIME_VERSION_SCAN_MISMATCH",
  );
  assert.equal(version.contentSafety.scanCurrent, true, "RUNTIME_VERSION_SCAN_EXPIRED");
  assert.equal(version.contentSafety.cloudValidated, false, "RUNTIME_CLOUD_GATE_CHANGED");
  assert.deepEqual(version.publicationBlockers, ["SCANNER_CLOUD_NOT_VALIDATED"]);
  const snapshot = version.snapshot;
  const inspection = item.inspection;
  assert.equal(snapshot?.kind, "art");
  assert.equal(snapshot.uploadId, inspection.uploadId, "RUNTIME_VERSION_UPLOAD_MISMATCH");
  for (const field of ["uploadRevision", "sha256", "size", "etag"])
    assert.equal(
      snapshot[field],
      inspection.checkedIdentity[field],
      "RUNTIME_VERSION_IDENTITY_MISMATCH",
    );
  assert.deepEqual(
    snapshot.inspection,
    {
      id: inspection.id,
      revision: inspection.revision,
      policy: inspection.policy,
    },
    "RUNTIME_VERSION_INSPECTION_MISMATCH",
  );
  assert.deepEqual(item.versionAfterPublication, version, "RUNTIME_PUBLICATION_MUTATED_VERSION");
  const events = item.versionEvents;
  assert.deepEqual(
    events?.map((event) => event.action),
    ["created", "approved"],
    "RUNTIME_VERSION_AUDIT_INVALID",
  );
  assert.deepEqual(
    events.map((event) => event.revision),
    [1, 2],
  );
  assert(typeof events[0].actor === "string" && events[0].actor.length > 0);
  assert.equal(events[1].actor, version.review.reviewer, "RUNTIME_REVIEW_ACTOR_MISMATCH");
  assert.notEqual(events[0].actor, events[1].actor, "RUNTIME_SELF_REVIEW_ACCEPTED");
}

/** 重新核验原始事实，不以数组长度、日志存在或 passed 布尔值替代必要场景。 */
export function verifyRuntimeCases(runtime, database, now = Date.now()) {
  const cases = runtime.cases;
  assert(Array.isArray(cases) && cases.length === names.length, "RUNTIME_CASES_INCOMPLETE");
  assert.deepEqual(
    cases.map((item) => item.name).sort(),
    [...names].sort(),
    "RUNTIME_CASE_SET_INVALID",
  );
  assert.deepEqual(runtime.actual?.scanningProcesses, [], "RUNTIME_PROCESS_CLEANUP_NOT_PROVEN");
  const byName = new Map(cases.map((item) => [item.name, item]));
  for (const [name, verdict] of [
    ["clean-two-png", "clean"],
    ["clean-ascii-no-utf8-flag", "clean"],
    ["eicar-stored-entry", "infected"],
    ["eicar-last-entry-deflate", "infected"],
    ["clean-after-disconnect", "clean"],
  ]) {
    const item = byName.get(name);
    assert.equal(item.status, 200, `RUNTIME_PROBE_FAILED:${name}`);
    assert.equal(item.clientAborted, false);
    scanFact(item.body, { sha256: item.inputSha256, size: item.bytes }, database, verdict, now);
  }
  const budget = byName.get("expanded-file-limit");
  assert.equal(budget.status, 422, "RUNTIME_BUDGET_NOT_REJECTED");
  assert.equal(budget.clientAborted, false);
  assert.equal(budget.body?.error, "SCANNER_ZIP_BUDGET_INVALID");
  const pixels = byName.get("png-pixel-eicar-not-a-detection-proof");
  inspectionFact(pixels.inspection, 32, database, now);
  assert(
    typeof pixels.limitation === "string" && pixels.limitation.length > 0,
    "RUNTIME_DETECTION_LIMIT_MISSING",
  );
  const rejected = byName.get("eicar-disguised-as-png-format-rejected");
  assert.equal(rejected.inspection?.state, "rejected");
  assert.equal(rejected.inspection.error, "PNG_SIGNATURE_INVALID");
  assert.equal(rejected.inspection.result, null);
  assert.equal(rejected.scannerCalls, 0, "RUNTIME_FORMAT_REJECT_CALLED_SCANNER");
  const business = byName.get("real-av-version-approval-publish-blocked");
  inspectionFact(business.inspection, 2, database, now);
  versionFact(business);
  const disconnect = byName.get("http-disconnect");
  assert.equal(disconnect.status, 503, "RUNTIME_DISCONNECT_NOT_OBSERVED");
  assert.equal(disconnect.clientAborted, true, "RUNTIME_CLIENT_ABORT_NOT_PROVEN");
  assert(
    cases.indexOf(disconnect) < cases.indexOf(byName.get("clean-after-disconnect")),
    "RUNTIME_RECOVERY_ORDER_INVALID",
  );
  return { verifiedCases: names.length, schema: "scanner-runtime-cases-v2" };
}
