import assert from "node:assert/strict";
import { constants } from "node:fs";
import { copyFile, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./scanner-release-policy.mjs";

export const cmakeMaterial = {
  url: "https://dl-cdn.alpinelinux.org/alpine/v3.24/main/x86_64/cmake-4.2.3-r0.apk",
  bytes: 23946975,
  sha256: "960e712886a5453c2c2573364ecc98c28fc7e081270396c5d9a69756caa102c8",
};

/** Docker 内 CDN 传输曾返回 I/O error；在宿主有界取得同一签名 APK，不换源或放松签名。 */
export async function prepareCmakeMaterial(context, existing, fetcher = fetch) {
  const destination = path.join(context, "cmake.apk");
  if (existing) {
    assert.equal((await stat(existing)).size, cmakeMaterial.bytes, "CMAKE_MATERIAL_SIZE_MISMATCH");
    assert.equal(
      sha256(await readFile(existing)),
      cmakeMaterial.sha256,
      "CMAKE_MATERIAL_DIGEST_MISMATCH",
    );
    await copyFile(existing, destination, constants.COPYFILE_EXCL);
  } else {
    const response = await fetcher(cmakeMaterial.url, {
      redirect: "error",
      signal: AbortSignal.timeout(90000),
    });
    if (response.status !== 200) {
      await response.body?.cancel();
      throw new Error("CMAKE_MATERIAL_HTTP_ERROR");
    }
    assert(response.body, "CMAKE_MATERIAL_BODY_MISSING");
    const reader = response.body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        assert(size <= cmakeMaterial.bytes, "CMAKE_MATERIAL_TOO_LARGE");
        chunks.push(value);
      }
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    assert.equal(bytes.length, cmakeMaterial.bytes, "CMAKE_MATERIAL_SIZE_MISMATCH");
    assert.equal(sha256(bytes), cmakeMaterial.sha256, "CMAKE_MATERIAL_DIGEST_MISMATCH");
    await writeFile(destination, bytes, { flag: "wx" });
  }
  return cmakeMaterial;
}
