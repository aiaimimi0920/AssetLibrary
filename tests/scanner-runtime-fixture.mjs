import { sha256 } from "../scripts/scanner-release-policy.mjs";
import { imageEnvironment } from "./scanner-image-fixture.mjs";

/** 仅用于验证离线门禁的合成事实，不代表实际 AV、身份或云验收。 */
export function runtimeFixture(database, now, image) {
  const digest = "e".repeat(64);
  const fact = (verdict = "clean", size = 798) => ({
    protocol: "neuro-clamav-v1",
    verdict,
    sha256: digest,
    size,
    engineVersion: "1.5.4",
    database: {
      sha256: database.sha256,
      dailyVersion: database.dailyVersion,
      updatedAt: database.updatedAt,
    },
    completedAt: now,
    expiresAt: Math.min(now + 86400000, database.updatedAt + 172800000),
  });
  const probe = (name, verdict) => ({
    name,
    bytes: 798,
    inputSha256: digest,
    status: 200,
    clientAborted: false,
    body: fact(verdict),
  });
  const inspection = (fileCount) => ({
    id: "inspection-fixture",
    uploadId: "upload-fixture",
    policy: "art-zip-clamav-v1",
    state: "passed",
    revision: 3,
    bindingCurrent: true,
    publicationEligible: false,
    error: null,
    checkedIdentity: { uploadRevision: 2, sha256: digest, size: 798, etag: "etag-fixture" },
    result: {
      format: "zip",
      schema: "neuro-art-package-v1",
      fileCount,
      files: Array.from({ length: fileCount }, (_, index) => ({
        path: `frame-${index}.png`,
        mediaType: "image/png",
      })),
      bytesRead: 798,
      sha256: digest,
      scan: fact(),
    },
  });
  const checked = inspection(2);
  const runtime = {
    image: {
      id: image,
      signatureRefresh: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      created: new Date(now).toISOString(),
    },
    actual: { temporary: [], scanningProcesses: [], database, environment: imageEnvironment() },
    cases: [
      probe("clean-two-png", "clean"),
      probe("clean-ascii-no-utf8-flag", "clean"),
      probe("eicar-stored-entry", "infected"),
      probe("eicar-last-entry-deflate", "infected"),
      {
        name: "expanded-file-limit",
        status: 422,
        clientAborted: false,
        body: { error: "SCANNER_ZIP_BUDGET_INVALID" },
      },
      {
        name: "png-pixel-eicar-not-a-detection-proof",
        inspection: inspection(32),
        limitation: "该样本不是 PNG 内部检测证明。",
      },
      {
        name: "eicar-disguised-as-png-format-rejected",
        inspection: { state: "rejected", error: "PNG_SIGNATURE_INVALID", result: null },
        scannerCalls: 0,
      },
      {
        name: "real-av-version-approval-publish-blocked",
        inspection: checked,
        version: {
          id: "version-fixture",
          state: "approved",
          revision: 2,
          review: { reviewer: "user:reviewer", decision: "approved" },
          bindingCurrent: true,
          publicationEligible: false,
          contentSafety: { scan: checked.result.scan, scanCurrent: true, cloudValidated: false },
          publicationBlockers: ["SCANNER_CLOUD_NOT_VALIDATED"],
          snapshot: {
            kind: "art",
            uploadId: checked.uploadId,
            ...checked.checkedIdentity,
            inspection: { id: checked.id, revision: checked.revision, policy: checked.policy },
          },
        },
        creationStatus: 201,
        approvalStatus: 200,
        publicationStatus: 409,
        versionEvents: [
          { actor: "user:owner", action: "created", revision: 1 },
          { actor: "user:reviewer", action: "approved", revision: 2 },
        ],
        published: { error: "SCANNER_CLOUD_NOT_VALIDATED" },
      },
      { name: "http-disconnect", status: 503, clientAborted: true, body: {} },
      probe("clean-after-disconnect", "clean"),
    ],
  };
  const business = runtime.cases.find(
    (item) => item.name === "real-av-version-approval-publish-blocked",
  );
  business.versionAfterPublication = structuredClone(business.version);
  return runtime;
}

export function releaseDatabase(time) {
  const files = ["main", "daily", "bytecode"].map((name, index) => ({
    name: `${name}.cvd`,
    sha256: String(index + 1).repeat(64),
    version: 100 + index,
    updatedAt: time,
  }));
  return { files, sha256: sha256(JSON.stringify(files)), dailyVersion: 101, updatedAt: time };
}
