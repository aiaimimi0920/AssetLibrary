import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { changed, packageBytes } from "../tests/art-package-fixture.mjs";
import { fixture } from "../tests/fixture.mjs";
import { chunk, header, png, read, signature } from "../tests/inspection-fixture.mjs";
import { queuedScan, runScanner } from "../tests/scanner-fixture.mjs";
import { sha256 } from "../tests/upload-fixture.mjs";
import {
  createVersion,
  events,
  readVersion,
  review,
  reviewerConfig,
} from "../tests/version-fixture.mjs";
import { artZip } from "./art-package-zip.mjs";
import { build } from "./build.mjs";
import { localScanner } from "./scanner-local.mjs";
import { verifyInstalledEngine } from "./scanner-native-installation.mjs";

/** fixture 销毁失败仍须尝试容器清理，不把清理错误吞成通过。 */
export async function disposeScannerFixture(fixture, scanner) {
  try {
    await fixture?.dispose();
  } finally {
    await scanner.cleanup();
  }
}

export async function verifyScanner(output) {
  output ??= await build();
  process.env.ASSETLIBRARY_BUNDLE = path.join(output, "index.js");
  const scanner = await localScanner(output);
  const cases = [];
  let f;
  let engine;
  const eicar = Buffer.from(
    ["X5O!P%@AP[4", "\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""),
  );
  async function probe(name, bytes, verdict, abortAfter) {
    const started = Date.now();
    const response = await scanner.request(
      "POST",
      "/scan",
      bytes,
      {
        "content-type": "application/zip",
        "content-length": String(bytes.length),
        "x-object-sha256": sha256(bytes),
      },
      abortAfter,
    );
    const body = await response.json();
    if (verdict) {
      assert.equal(response.status, 200, JSON.stringify(body));
      assert.equal(body.verdict, verdict);
      assert.equal(body.sha256, sha256(bytes));
      assert.equal(body.size, bytes.length);
      assert.equal(body.engineVersion, "1.5.4");
    } else if (abortAfter) {
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("x-scanner-probe-aborted"), "true");
    } else {
      assert.equal(response.status, 422);
      assert.equal(body.error, "SCANNER_ZIP_BUDGET_INVALID");
    }
    cases.push({
      name,
      bytes: bytes.length,
      inputSha256: sha256(bytes),
      status: response.status,
      clientAborted: response.headers.get("x-scanner-probe-aborted") === "true",
      elapsedMs: Date.now() - started,
      body,
    });
    return body;
  }
  try {
    engine = await scanner.engineFiles();
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    if (manifest.artifacts["scanner/native-install.json"]) {
      const native = JSON.parse(
        await readFile(path.join(output, "scanner/native-install.json"), "utf8"),
      );
      verifyInstalledEngine(native.installed, engine);
    }
    f = await fixture({ reviewers: reviewerConfig });
    await probe("clean-two-png", packageBytes(), "clean");
    await probe(
      "clean-ascii-no-utf8-flag",
      changed(packageBytes(), (bytes, records) => {
        for (const record of records) {
          bytes.writeUInt16LE(0, record.local + 6);
          bytes.writeUInt16LE(0, record.central + 8);
        }
      }),
      "clean",
    );
    await probe("eicar-stored-entry", artZip([{ path: "test.bin", bytes: eicar }], 0), "infected");
    const files = Array.from({ length: 32 }, (_, index) => ({
      path: `file-${index}.bin`,
      bytes: index === 31 ? eicar : Buffer.from("harmless"),
    }));
    await probe("eicar-last-entry-deflate", artZip(files, 8), "infected");
    await probe(
      "expanded-file-limit",
      artZip([{ path: "large.bin", bytes: Buffer.alloc(9 * 1024 * 1024) }], 8),
      undefined,
    );
    const pixels = Buffer.alloc(129);
    eicar.copy(pixels, 1);
    const image = Buffer.concat([
      signature,
      header(32, 1),
      chunk("IDAT", deflateSync(pixels, { level: 0 })),
      chunk("IEND"),
    ]);
    const infectedPackage = packageBytes(
      Array.from({ length: 32 }, (_, index) => ({
        path: `frame-${index}.png`,
        bytes: index === 31 ? image : png(),
      })),
      { method: 8 },
    );
    const infected = await queuedScan(f, infectedPackage);
    await runScanner(f, scanner.binding);
    const pixelResult = (await read(f, infected)).body;
    assert.equal(pixelResult.state, "passed");
    cases.push({
      name: "png-pixel-eicar-not-a-detection-proof",
      inspection: pixelResult,
      limitation:
        "标准 EICAR 串放进有效 PNG 像素不是该官方签名的命中样本，不能声称此用例证明 PNG 内部检测。",
    });
    const fakePng = await queuedScan(f, packageBytes([{ path: "test.png", bytes: eicar }]));
    let calls = 0;
    await runScanner(f, {
      fetch: async () => {
        calls++;
        throw new Error("UNEXPECTED_SCAN");
      },
    });
    const rejected = (await read(f, fakePng)).body;
    assert.equal(rejected.state, "rejected");
    assert.equal(rejected.error, "PNG_SIGNATURE_INVALID");
    assert.equal(calls, 0);
    cases.push({
      name: "eicar-disguised-as-png-format-rejected",
      inspection: rejected,
      scannerCalls: calls,
    });
    const clean = await queuedScan(f);
    await runScanner(f, scanner.binding);
    const checked = (await read(f, clean)).body;
    assert.equal(checked.state, "passed");
    assert.equal(checked.result.fileCount, 2);
    const version = await createVersion(f, clean);
    assert.equal(version.status, 201);
    const approved = await review(f, version.body);
    assert.equal(approved.status, 200);
    assert.equal(approved.body.state, "approved");
    const published = await f.request("POST", `/v1/versions/${version.body.id}/publish`, {
      revision: 2,
    });
    assert.equal(published.status, 409);
    assert.equal(published.body.error, "SCANNER_CLOUD_NOT_VALIDATED");
    const versionEvents = await events(f, version.body);
    assert.deepEqual(
      versionEvents.map((event) => event.action),
      ["created", "approved"],
    );
    const afterPublication = await readVersion(f, version.body);
    assert.equal(afterPublication.status, 200);
    assert.deepEqual(afterPublication.body, approved.body);
    cases.push({
      name: "real-av-version-approval-publish-blocked",
      inspection: checked,
      version: approved.body,
      versionAfterPublication: afterPublication.body,
      creationStatus: version.status,
      approvalStatus: approved.status,
      publicationStatus: published.status,
      versionEvents,
      published: published.body,
    });
    // 主动断开真实 HTTP 请求；随后 clean 和最终快照验证恢复，不推断已进入 AV 子进程。
    await probe("http-disconnect", packageBytes(), undefined, 1500);
    await new Promise((resolve) => setTimeout(resolve, 1000));
    await probe("clean-after-disconnect", packageBytes(), "clean");
    const actual = await scanner.files();
    actual.engine = engine;
    actual.environment = scanner.environment;
    assert.deepEqual(actual.temporary, []);
    assert.deepEqual(actual.scanningProcesses, []);
    for (const [name, digest] of Object.entries(actual.files)) {
      assert.equal(
        digest,
        createHash("sha256")
          .update(await readFile(path.join(output, "scanner", name)))
          .digest("hex"),
      );
    }
    await writeFile(
      path.join(output, "scanner/runtime-validation.json"),
      `${JSON.stringify({ stage: "P3.3b-local", image: scanner.image, actual, cases, nativeContainerValidated: false, cloudValidated: false }, null, 2)}\n`,
      "utf8",
    );
  } finally {
    await disposeScannerFixture(f, scanner);
  }
  const manifestPath = path.join(output, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  for (const name of [
    "runtime-validation.json",
    "cleanup.json",
    "runtime.log",
    "image-build.log",
  ]) {
    manifest.artifacts[`scanner/${name}`] = createHash("sha256")
      .update(await readFile(path.join(output, "scanner", name)))
      .digest("hex");
  }
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`Scanner verification passed: ${cases.length} cases; ${output}`);
  return output;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await verifyScanner();
