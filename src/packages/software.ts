import { ContentRejected } from "../inspections/png";
import { manifestFields, readManifest } from "./manifest";
import { entryBytes, parseZip } from "./zip";

/** 资源库只验证传输封装和原字节完整性，不加载软件、解析宿主指令或验证其可执行性。 */
export async function inspectSoftwarePackage(
  bytes: Uint8Array,
  kind: "capability" | "application",
) {
  const entries = parseZip(bytes);
  const first = entries[0];
  if (!first) throw new ContentRejected("PACKAGE_LAYOUT_INVALID");
  const body = readManifest(await entryBytes(first), ["schema", "kind", "files"]);
  if (
    body.schema !== "neuro-software-package-v1" ||
    body.kind !== kind ||
    !Array.isArray(body.files) ||
    body.files.length !== entries.length - 1
  )
    throw new ContentRejected("PACKAGE_MANIFEST_INVALID");
  const files = [];
  let totalUnpackedBytes = first.size;
  for (let index = 1; index < entries.length; index++) {
    const entry = entries[index];
    const file = manifestFields(body.files[index - 1], ["path", "size", "sha256"]);
    if (
      !entry ||
      file.path !== entry.path ||
      file.size !== entry.size ||
      typeof file.sha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(file.sha256)
    )
      throw new ContentRejected("PACKAGE_MANIFEST_MISMATCH");
    const data = await entryBytes(entry);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (sha256 !== file.sha256) throw new ContentRejected("PACKAGE_FILE_DIGEST_MISMATCH");
    totalUnpackedBytes += data.byteLength;
    files.push({ path: entry.path, size: data.byteLength, sha256 });
  }
  return {
    format: "zip",
    schema: "neuro-software-package-v1",
    kind,
    fileCount: files.length,
    totalUnpackedBytes,
    files,
  };
}
