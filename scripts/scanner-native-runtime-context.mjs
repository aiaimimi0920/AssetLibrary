import assert from "node:assert/strict";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { nativeProofFiles, verifyNativeProof } from "./scanner-native-policy.mjs";
import { sha256 } from "./scanner-release-policy.mjs";
import { root } from "./source-scope.mjs";

/** 仅装配独占候选，不改活动 Dockerfile；安装 tar 与原生证明一起进入候选 manifest。 */
export async function applyNativeRuntime(output, input) {
  const native = path.resolve(input);
  const receiptBytes = await readFile(path.join(native, "receipt.json"));
  const receipt = JSON.parse(receiptBytes);
  assert.deepEqual(await nativeProofFiles(native), receipt.files, "NATIVE_EVIDENCE_CHANGED");
  assert.deepEqual(await verifyNativeProof(native), receipt.verification, "NATIVE_PROOF_CHANGED");
  const install = path.join(native, "proof/evidence/install.tar");
  const installSha256 = sha256(await readFile(install));
  const installed = JSON.parse(
    await readFile(path.join(native, "proof/evidence/installed-files.json"), "utf8"),
  );
  await copyFile(install, path.join(output, "scanner/install.tar"));
  assert.equal(
    sha256(await readFile(path.join(output, "scanner/install.tar"))),
    installSha256,
    "NATIVE_INSTALL_COPY_CHANGED",
  );
  await copyFile(
    path.join(root, "scanner/native-runtime.Dockerfile"),
    path.join(output, "scanner/Dockerfile"),
  );
  const ignore = path.join(output, "scanner/.dockerignore");
  await writeFile(ignore, `${await readFile(ignore, "utf8")}\n!install.tar\n`);
  await writeFile(
    path.join(output, "scanner/native-install.json"),
    `${JSON.stringify(
      {
        native,
        nativeReceiptSha256: sha256(receiptBytes),
        originalImage: receipt.image,
        installSha256,
        installed,
        productionReady: false,
        activeScannerReplaced: false,
      },
      null,
      2,
    )}\n`,
    { flag: "wx" },
  );
  assert.deepEqual(
    await nativeProofFiles(native),
    receipt.files,
    "NATIVE_EVIDENCE_CHANGED_DURING_COPY",
  );
}
