import { ContentRejected, inspectPng } from "../inspections/png";
import { manifestFields, readManifest } from "./manifest";
import { entryBytes, parseZip } from "./zip";

function manifest(bytes: Uint8Array, count: number) {
  const body = readManifest(bytes, ["schema", "files"]);
  if (
    body.schema !== "neuro-art-package-v1" ||
    !Array.isArray(body.files) ||
    body.files.length !== count
  )
    throw new ContentRejected("PACKAGE_MANIFEST_INVALID");
  return body.files.map((file) => manifestFields(file, ["path", "size", "sha256", "mediaType"]));
}

/** 一次只解包和检查一个条目，不写入文件系统，不执行任何包内内容。 */
export async function inspectArtPackage(bytes: Uint8Array) {
  const entries = parseZip(bytes);
  if (entries.slice(1).some((entry) => !entry.path.toLowerCase().endsWith(".png")))
    throw new ContentRejected("PACKAGE_LAYOUT_INVALID");
  const first = entries[0];
  if (!first) throw new ContentRejected("PACKAGE_LAYOUT_INVALID");
  const files = manifest(await entryBytes(first), entries.length - 1);
  const results = [];
  let totalPixels = 0;
  let totalUnpackedBytes = first.size;
  for (let index = 1; index < entries.length; index++) {
    const entry = entries[index];
    const file = files[index - 1];
    if (
      !entry ||
      !file ||
      file.path !== entry.path ||
      file.size !== entry.size ||
      file.mediaType !== "image/png" ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new ContentRejected("PACKAGE_MANIFEST_MISMATCH");
    const data = await entryBytes(entry);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (sha256 !== file.sha256) throw new ContentRejected("PACKAGE_FILE_DIGEST_MISMATCH");
    const png = await inspectPng(data, 1048576 - totalPixels);
    totalPixels += png.width * png.height;
    totalUnpackedBytes += data.byteLength;
    results.push({
      path: entry.path,
      size: data.byteLength,
      sha256,
      mediaType: "image/png",
      width: png.width,
      height: png.height,
      decodedBytes: png.decodedBytes,
    });
  }
  return {
    format: "zip",
    schema: "neuro-art-package-v1",
    fileCount: results.length,
    totalUnpackedBytes,
    totalPixels,
    files: results,
  };
}
