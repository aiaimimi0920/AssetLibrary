import { ContentRejected } from "../inspections/png";
import { entryBytes, parseLoomZip } from "./zip";

/** 仅核验原生 ZIP 的有界容器及类型标记；宿主验签、权限和运行兼容性仍由 Loom 决定。 */
export async function inspectLoomPackage(bytes: Uint8Array, kind: "art" | "capability") {
  const entries = parseLoomZip(bytes, kind);
  const files = [];
  let totalUnpackedBytes = 0;
  for (const entry of entries) {
    const data = await entryBytes(entry);
    const digest = await crypto.subtle.digest("SHA-256", data);
    const sha256 = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
    // 不从清单授予任何信任或权限，也不把语义解析后的 JSON 回写进原包。
    if (["manifest.json", "capability.manifest.json", "art.runtime.json"].includes(entry.path)) {
      try {
        if (data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) throw new Error();
        const body = JSON.parse(
          new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(data),
        );
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
        if (entry.path === "capability.manifest.json" && body.kind !== "capability")
          throw new Error();
        if (entry.path === "manifest.json" && body.execution?.type !== "framework_art")
          throw new Error();
      } catch {
        throw new ContentRejected("PACKAGE_MANIFEST_INVALID");
      }
    }
    files.push({ path: entry.path, size: data.byteLength, sha256 });
    totalUnpackedBytes += data.byteLength;
  }
  return {
    format: "zip",
    schema: "loom-native-zip-v1",
    kind,
    fileCount: files.length,
    totalUnpackedBytes,
    files,
  };
}
