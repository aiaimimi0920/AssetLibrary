import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { changed, inspectPackage, packageBytes, startPackage } from "./art-package-fixture.mjs";
import { fixture } from "./fixture.mjs";
import { dueInspection, prepared, read } from "./inspection-fixture.mjs";
import { assertNotPassed, cleanFact, jsonFact, runScanner } from "./scanner-fixture.mjs";
import {
  checkedSoftware,
  queueSoftware,
  softwareBytes,
  softwareFiles,
  softwareManifest,
  softwarePolicy,
} from "./software-package-fixture.mjs";
import { cancel } from "./upload-fixture.mjs";
import { createVersion, reviewerConfig } from "./version-fixture.mjs";

let f;
before(async () => {
  f = await fixture({ reviewers: reviewerConfig });
});
after(async () => f?.dispose());

async function rejects(kind, bytes, error) {
  const upload = await queueSoftware(f, kind, bytes);
  let calls = 0;
  await runScanner(f, {
    fetch: async () => {
      calls++;
      return jsonFact(cleanFact(upload));
    },
  });
  const checked = await assertNotPassed(f, upload, "rejected");
  assert.equal(checked.error, error);
  assert.equal(calls, 0, "格式错误不得进入扫描器");
  assert.equal((await createVersion(f, upload)).body.error, "VERSION_BINDING_NOT_READY");
}

test("三种资源只能选择自己的检查策略；无匹配策略时不创建任务或版本", async () => {
  for (const kind of ["art", "capability", "application"]) {
    const upload = await prepared(f, softwareBytes("capability"), kind);
    for (const other of ["art", "capability", "application"].filter((value) => value !== kind)) {
      const policy = other === "art" ? "art-zip-clamav-v1" : softwarePolicy(other);
      assert.equal(
        (await startPackage(f, upload, policy)).body.error,
        "INSPECTION_POLICY_UNAVAILABLE",
      );
    }
    assert.equal((await read(f, upload)).status, 404);
    assert.equal((await createVersion(f, upload)).body.error, "VERSION_BINDING_NOT_READY");
  }
});

for (const kind of ["capability", "application"])
  test(`${kind} 清单类型、字段、重复键、编码、顺序、大小和逐项摘要均失败关闭`, async () => {
    const files = softwareFiles();
    const body = softwareManifest(kind, files);
    for (const [manifest, error] of [
      [
        JSON.stringify({ ...body, kind: kind === "capability" ? "application" : "capability" }),
        "PACKAGE_MANIFEST_INVALID",
      ],
      [JSON.stringify({ ...body, schema: "neuro-art-package-v1" }), "PACKAGE_MANIFEST_INVALID"],
      [JSON.stringify({ ...body, extra: true }), "PACKAGE_MANIFEST_INVALID"],
      [`{"kind":"wrong",${JSON.stringify(body).slice(1)}`, "PACKAGE_MANIFEST_NONCANONICAL"],
      [`\ufeff${JSON.stringify(body)}`, "PACKAGE_MANIFEST_INVALID"],
      [Buffer.from([0xff, 0xfe]), "PACKAGE_MANIFEST_INVALID"],
      [JSON.stringify({ ...body, files: body.files.slice(1) }), "PACKAGE_MANIFEST_INVALID"],
      [JSON.stringify({ ...body, files: [...body.files].reverse() }), "PACKAGE_MANIFEST_MISMATCH"],
      [
        JSON.stringify({ ...body, files: body.files.map((file) => ({ ...file, size: 1 })) }),
        "PACKAGE_MANIFEST_MISMATCH",
      ],
      [
        JSON.stringify({
          ...body,
          files: body.files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
        }),
        "PACKAGE_FILE_DIGEST_MISMATCH",
      ],
      [
        JSON.stringify({ ...body, files: body.files.map((file) => ({ ...file, extra: true })) }),
        "PACKAGE_MANIFEST_INVALID",
      ],
    ])
      await rejects(kind, softwareBytes(kind, { files, manifest }), error);
  });

test("软件 ZIP 仍拒绝路径穿越、链接/执行权限、坏 CRC；Art 不会因通用容器而接受软件", async () => {
  await rejects(
    "capability",
    softwareBytes("capability", {
      files: [{ path: "../escape.js", bytes: Buffer.from("data") }],
    }),
    "ZIP_PATH_INVALID",
  );
  const bytes = softwareBytes("capability");
  for (const mode of [0xa1ff, 0x81ed])
    await rejects(
      "capability",
      changed(bytes, (b, records) => {
        b.writeUInt32LE((mode << 16) >>> 0, records[1].central + 38);
      }),
      "ZIP_FILE_TYPE_UNSUPPORTED",
    );
  await rejects(
    "capability",
    changed(bytes, (b, records) => {
      b[records[1].data] ^= 1;
    }),
    "ZIP_CRC_INVALID",
  );
  await inspectPackage(f, packageBytes(softwareFiles()), "rejected", "PACKAGE_LAYOUT_INVALID");
});

test("软件预算真实边界：1 MiB 与 32 个条目可检查，越一字节/条目或空文件均拒绝", async () => {
  await checkedSoftware(
    f,
    "capability",
    softwareBytes("capability", {
      files: [{ path: "payload.bin", bytes: Buffer.alloc(1048576, 42) }],
    }),
  );
  for (const size of [0, 1048577])
    await rejects(
      "application",
      softwareBytes("application", {
        files: [{ path: "payload.bin", bytes: Buffer.alloc(size, 42) }],
      }),
      "ZIP_EXPANSION_LIMIT",
    );
  const files = Array.from({ length: 32 }, (_, index) => ({
    path: `file-${index}.bin`,
    bytes: Buffer.from([index]),
  }));
  const { checked } = await checkedSoftware(
    f,
    "application",
    softwareBytes("application", { files }),
  );
  assert.equal(checked.result.fileCount, 32);
  await rejects(
    "application",
    softwareBytes("application", {
      files: [...files, { path: "file-32.bin", bytes: Buffer.from([32]) }],
    }),
    "ZIP_ENTRY_LIMIT",
  );
});

test("软件检查重复请求不重置三次预算，缺失/坏扫描事实与 infected 均不能通过", async () => {
  const upload = await queueSoftware(f, "capability");
  let calls = 0;
  for (let attempt = 1; attempt <= 3; attempt++) {
    await dueInspection(f, upload);
    await runScanner(f, {
      fetch: async () => {
        calls++;
        return new Response(null, { status: 503 });
      },
    });
    const checked = await assertNotPassed(f, upload, attempt === 3 ? "failed" : "queued");
    assert.equal(checked.attempts, attempt);
    const replay = await startPackage(f, upload, softwarePolicy("capability"));
    assert.equal(replay.status, 200);
    assert.equal(replay.body.attempts, attempt);
    assert.equal(replay.body.revision, checked.revision);
  }
  assert.equal(calls, 3);
  for (const verdict of ["missing", "mismatch", "infected"]) {
    const other = await queueSoftware(f, "application");
    await runScanner(
      f,
      verdict === "missing"
        ? undefined
        : {
            fetch: async () =>
              jsonFact(
                cleanFact(other, verdict === "infected" ? { verdict } : { sha256: "b".repeat(64) }),
              ),
          },
    );
    await assertNotPassed(f, other, verdict === "infected" ? "rejected" : "queued");
    await cancel(f, other);
  }
  assert.equal((await read(f, upload)).body.attempts, 3);
});

test("软件扫描持有字节时取消或类型失配，晚到 clean 不能提交 passed", async () => {
  for (const kind of ["capability", "application"]) {
    const upload = await queueSoftware(f, kind);
    let observed, release;
    const captured = new Promise((resolve) => {
      observed = resolve;
    });
    const barrier = new Promise((resolve) => {
      release = resolve;
    });
    const pending = runScanner(f, {
      fetch: async () => {
        observed();
        await barrier;
        return jsonFact(cleanFact(upload));
      },
    });
    try {
      await captured;
      if (kind === "application") await cancel(f, upload);
      else
        await f.db
          .prepare("UPDATE resources SET kind = 'application' WHERE id = ?")
          .bind(upload.resourceId)
          .run();
    } finally {
      release();
    }
    await pending;
    await assertNotPassed(f, upload, "invalidated");
    assert.equal((await createVersion(f, upload)).body.error, "VERSION_BINDING_NOT_READY");
  }
});

test("新 Schema 拒绝软件结果 kind/schema/scan 缺失，以及版本 kind 与策略交叉绑定", async () => {
  const { upload, checked } = await checkedSoftware(f, "capability");
  for (const change of [{ kind: "application" }, { schema: "wrong" }, { scan: null }])
    await assert.rejects(
      f.db
        .prepare("UPDATE inspections SET result = ? WHERE upload_id = ?")
        .bind(JSON.stringify({ ...checked.result, ...change }), upload.id)
        .run(),
      /CHECK constraint failed/,
    );
  const created = await createVersion(f, upload);
  assert.equal(created.status, 201);
  await assert.rejects(
    f.db
      .prepare("UPDATE versions SET kind = 'application' WHERE id = ?")
      .bind(created.body.id)
      .run(),
    /CHECK constraint failed/,
  );
});
