import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

export function releaseFixture(now = Date.now()) {
  return {
    schemaVersion: 1,
    release: {
      id: "1".repeat(64),
      accountId: "2".repeat(32),
      worker: "test-app",
      origin: "https://assetlibrary-test.invalid",
      service: "test-scanner",
      workerVersionId: randomUUID(),
      containerApplicationId: randomUUID(),
      namespaceId: "3".repeat(32),
      imageDigest: `sha256:${"4".repeat(64)}`,
      imageId: `sha256:${"5".repeat(64)}`,
      database: { sha256: "a".repeat(64), dailyVersion: 1, updatedAt: now - 60000 },
      validatedAt: now - 30000,
      expiresAt: now + 3600000,
      evidence: {
        candidate: "6".repeat(64),
        nativeReview: "7".repeat(64),
        cloudValidation: "8".repeat(64),
      },
    },
  };
}

/** 仅测试进程内替换版本内记录；保留真正的生产准入函数，不注入放行开关。 */
export function withReleaseDocument(source, document) {
  if (document === undefined) return source;
  const pattern =
    /\/\/ src\/scanner\/deployment-release\.json\r?\nvar deployment_release_default = [\s\S]*?;\r?\n/;
  assert.equal([...source.matchAll(new RegExp(pattern, "g"))].length, 1, "RELEASE_MODULE_CHANGED");
  return source.replace(
    pattern,
    () => `var deployment_release_default = ${JSON.stringify(document)};\n`,
  );
}
