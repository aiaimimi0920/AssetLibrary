import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { nativeEnginePaths } from "../scripts/scanner-native-installation.mjs";
import { sha256, trivyWindowsSha256 } from "../scripts/scanner-release-policy.mjs";
import { loadRelease } from "../scripts/scanner-release-proof.mjs";
import { artifactRoot } from "../scripts/source-scope.mjs";

async function fixture(native = false) {
  const directory = await mkdtemp(path.join(artifactRoot, "scanner-release-proof-"));
  await mkdir(path.join(directory, "scanner"));
  const image = `sha256:${"a".repeat(64)}`;
  const artifacts = {};
  const runtime = { image: { id: image }, actual: { files: {} } };
  for (const name of ["database.mjs", "process.mjs", "server.mjs", "limits.mjs"]) {
    const bytes = `// isolated fixture ${name}\n`;
    await writeFile(path.join(directory, `scanner/${name}`), bytes);
    artifacts[`scanner/${name}`] = runtime.actual.files[name] = sha256(bytes);
  }
  if (native) {
    const installed = {};
    runtime.actual.engine = {};
    for (const name of nativeEnginePaths) {
      installed[name.slice(1)] = { sha256: "c".repeat(64) };
      runtime.actual.engine[name] = { path: name, sha256: "c".repeat(64) };
    }
    for (const [relative, bytes] of Object.entries({
      "scanner/install.tar": "fixture-install",
      "scanner/native-install.json": JSON.stringify({
        installed,
        nativeReceiptSha256: "d".repeat(64),
        installSha256: sha256("fixture-install"),
      }),
    })) {
      await writeFile(path.join(directory, relative), bytes);
      artifacts[relative] = sha256(bytes);
    }
  }
  const contents = {
    "manifest.json": { artifacts },
    "scanner/runtime-validation.json": runtime,
    "scanner/cleanup.json": { removed: true, imageRetained: image },
    "scanner/image-build.log": "build",
    "scanner/vulnerabilities.json": { Metadata: { ImageID: image } },
    "scanner/vulnerability-database.json": { Version: 2 },
    "scanner/vulnerability-scan.log": "scan",
    "scanner/trivy-empty.yaml": "{}\n",
    "scanner/trivy-empty.ignore": "",
  };
  const files = {};
  for (const [relative, value] of Object.entries(contents)) {
    const bytes = typeof value === "string" ? value : JSON.stringify(value);
    await writeFile(path.join(directory, relative), bytes);
    files[relative] = sha256(bytes);
  }
  const receipt = {
    format: 1,
    files,
    scanCommand: { executableSha256: trivyWindowsSha256, noIgnoreUnfixed: true },
    assessment: { candidateEligible: true },
  };
  const save = () =>
    writeFile(path.join(directory, "scanner/release.json"), JSON.stringify(receipt));
  await save();
  return { directory, receipt, save };
}

test("重新读取绑定的原始证据；文件被改后即使旧allowed为true也拒绝", async () => {
  const f = await fixture();
  try {
    assert.equal((await loadRelease(f.directory)).runtime.image.id, `sha256:${"a".repeat(64)}`);
    await writeFile(path.join(f.directory, "scanner/vulnerabilities.json"), "{}\n");
    await assert.rejects(loadRelease(f.directory), /RELEASE_FILE_CHANGED/);
  } finally {
    await rm(f.directory, { recursive: true });
  }
});

test("关键证据摘要不能省略；不能使用越界相对路径", async () => {
  const f = await fixture();
  try {
    const previous = f.receipt.files["scanner/cleanup.json"];
    delete f.receipt.files["scanner/cleanup.json"];
    await f.save();
    await assert.rejects(loadRelease(f.directory), /RELEASE_EVIDENCE_MISSING/);
    f.receipt.files["scanner/cleanup.json"] = previous;
    f.receipt.files["../outside"] = "a".repeat(64);
    await f.save();
    await assert.rejects(loadRelease(f.directory), /RELEASE_PATH_INVALID/);
  } finally {
    await rm(f.directory, { recursive: true });
  }
});

test("产物被改或cleanup属于其他镜像时拒绝，不以日志文件存在算通过", async () => {
  const f = await fixture();
  try {
    const filename = path.join(f.directory, "scanner/cleanup.json");
    const value = JSON.parse(await readFile(filename, "utf8"));
    value.imageRetained = `sha256:${"b".repeat(64)}`;
    const bytes = JSON.stringify(value);
    await writeFile(filename, bytes);
    f.receipt.files["scanner/cleanup.json"] = sha256(bytes);
    await f.save();
    await assert.rejects(loadRelease(f.directory), /CLEANUP_IMAGE_MISMATCH/);
  } finally {
    await rm(f.directory, { recursive: true });
  }
});

test("受控候选重新评估必须核对安装归档和全部运行二进制，而非只信冻结文件存在", async () => {
  const f = await fixture(true);
  try {
    await loadRelease(f.directory);
    const relative = "scanner/runtime-validation.json";
    const value = JSON.parse(await readFile(path.join(f.directory, relative), "utf8"));
    value.actual.engine["/usr/lib/libclamunrar.so"].sha256 = "e".repeat(64);
    const bytes = JSON.stringify(value);
    await writeFile(path.join(f.directory, relative), bytes);
    f.receipt.files[relative] = sha256(bytes);
    await f.save();
    await assert.rejects(loadRelease(f.directory), /NATIVE_PRODUCT_BINARY_CHANGED/);
  } finally {
    await rm(f.directory, { recursive: true });
  }
});

test("重绑报告摘要不能让 clamscan 身份替代 UnRAR 引擎", async () => {
  const f = await fixture(true);
  try {
    const relative = "scanner/runtime-validation.json";
    const value = JSON.parse(await readFile(path.join(f.directory, relative), "utf8"));
    value.actual.engine["/usr/lib/libclamunrar.so"] = value.actual.engine["/usr/bin/clamscan"];
    const bytes = JSON.stringify(value);
    await writeFile(path.join(f.directory, relative), bytes);
    f.receipt.files[relative] = sha256(bytes);
    await f.save();
    await assert.rejects(loadRelease(f.directory), /NATIVE_PRODUCT_BINARY_PATH_MISMATCH/);
  } finally {
    await rm(f.directory, { recursive: true });
  }
});
