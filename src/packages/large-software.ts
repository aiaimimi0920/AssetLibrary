import { ContentRejected } from "../inspections/png";
import {
  ArchiveStream,
  digestEntry,
  largeArchiveLimit,
  largeEntryLimit,
  largeFileLimit,
  largeUnpackedLimit,
} from "./archive-stream";
import { manifestFields, readManifest } from "./manifest";
import { packagePath } from "./paths";

function requireZip(condition: boolean, code = "ZIP_STRUCTURE_INVALID"): asserts condition {
  if (!condition) throw new ContentRejected(code);
}

function pathOf(bytes: Uint8Array) {
  requireZip(
    bytes.length > 0 && bytes.length <= 180 && bytes.every((byte) => byte < 128),
    "ZIP_PATH_INVALID",
  );
  return packagePath(new TextDecoder().decode(bytes));
}

function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
}

interface Entry {
  path: string;
  offset: number;
  header: Uint8Array;
  size: number;
  sha256: string;
}

/** 顺序验证 local/central/EOCD 和文件摘要；载荷逐块解压，不保存整个 ZIP/EXE。 */
export async function inspectLargeSoftware(
  body: ReadableStream<Uint8Array>,
  size: number,
  sha256: string,
) {
  requireZip(Number.isSafeInteger(size) && size > 0 && size <= largeArchiveLimit, "ZIP_SIZE_LIMIT");
  const stream = new ArchiveStream(body, size);
  const entries: Entry[] = [];
  let manifest: Record<string, unknown>[] = [];
  let total = 0;
  try {
    let signature = await stream.read(4);
    while (view(signature).getUint32(0, true) === 0x04034b50) {
      requireZip(entries.length < largeEntryLimit, "ZIP_ENTRY_LIMIT");
      const offset = stream.position - 4;
      const header = await stream.read(26);
      const h = view(header);
      const needed = h.getUint16(0, true);
      const flags = h.getUint16(2, true);
      const method = h.getUint16(4, true);
      const crc = h.getUint32(10, true);
      const compressed = h.getUint32(14, true);
      const unpacked = h.getUint32(18, true);
      const nameLength = h.getUint16(22, true);
      requireZip(
        (needed === 10 || needed === 20) &&
          !(flags & ~0x800) &&
          (method === 0 || (method === 8 && needed === 20)) &&
          h.getUint16(24, true) === 0,
        "ZIP_FEATURE_UNSUPPORTED",
      );
      requireZip(nameLength <= 180, "ZIP_PATH_INVALID");
      const path = pathOf(await stream.read(nameLength));
      const folded = path.toLowerCase();
      requireZip(
        !entries.some((entry) => {
          const prior = entry.path.toLowerCase();
          return (
            prior === folded || prior.startsWith(`${folded}/`) || folded.startsWith(`${prior}/`)
          );
        }),
        "ZIP_PATH_COLLISION",
      );
      const first = entries.length === 0;
      requireZip(!first || path === "manifest.json", "PACKAGE_LAYOUT_INVALID");
      total += unpacked;
      requireZip(
        unpacked > 0 &&
          unpacked <= (first ? 32768 : largeFileLimit) &&
          total <= largeUnpackedLimit &&
          (unpacked <= 4096 || unpacked <= compressed * 100),
        "ZIP_EXPANSION_LIMIT",
      );
      requireZip(method !== 0 || compressed === unpacked);
      requireZip(stream.position + compressed <= size - 22);
      const result = await digestEntry(
        stream.segment(compressed),
        unpacked,
        crc,
        method,
        first,
        () => stream.failure,
      );
      if (first) {
        const value = readManifest(result.bytes ?? new Uint8Array(), ["schema", "kind", "files"]);
        requireZip(
          value.schema === "neuro-software-package-v1" &&
            value.kind === "application" &&
            Array.isArray(value.files) &&
            value.files.length >= 1 &&
            value.files.length < largeEntryLimit,
          "PACKAGE_MANIFEST_INVALID",
        );
        manifest = (value.files as unknown[]).map((file) =>
          manifestFields(file, ["path", "size", "sha256"]),
        );
      } else {
        const file = manifest[entries.length - 1];
        requireZip(file?.path === path && file.size === unpacked, "PACKAGE_MANIFEST_MISMATCH");
        requireZip(file.sha256 === result.sha256, "PACKAGE_FILE_DIGEST_MISMATCH");
      }
      entries.push({ path, offset, header, size: unpacked, sha256: result.sha256 });
      signature = await stream.read(4);
    }
    requireZip(
      entries.length === manifest.length + 1 && entries.length >= 2,
      "PACKAGE_LAYOUT_INVALID",
    );
    const central = stream.position - 4;
    for (const entry of entries) {
      requireZip(view(signature).getUint32(0, true) === 0x02014b50);
      const header = await stream.read(42);
      const h = view(header);
      const host = h.getUint16(0, true) >>> 8;
      const attributes = h.getUint32(34, true);
      const mode = attributes >>> 16;
      requireZip(
        (host === 0 || host === 3) &&
          (host !== 0 || mode === 0) &&
          !(attributes & 0xffff & ~0x27) &&
          (host !== 3 || (mode & 0xf000) === 0 || (mode & 0xf000) === 0x8000) &&
          !(mode & 0xe49),
        "ZIP_FILE_TYPE_UNSUPPORTED",
      );
      requireZip(
        h.getUint16(26, true) === 0 &&
          h.getUint16(28, true) === 0 &&
          h.getUint16(30, true) === 0 &&
          !(h.getUint16(32, true) & ~1),
        "ZIP_FEATURE_UNSUPPORTED",
      );
      // local 的 needed..nameLength 必须与 central 相同，杜绝元数据差异。
      requireZip(entry.header.subarray(0, 24).every((byte, index) => header[index + 2] === byte));
      requireZip(h.getUint32(38, true) === entry.offset);
      requireZip(pathOf(await stream.read(h.getUint16(24, true))) === entry.path);
      signature = await stream.read(4);
    }
    const centralSize = stream.position - 4 - central;
    requireZip(view(signature).getUint32(0, true) === 0x06054b50);
    const end = view(await stream.read(18));
    requireZip(
      end.getUint16(0, true) === 0 &&
        end.getUint16(2, true) === 0 &&
        end.getUint16(4, true) === entries.length &&
        end.getUint16(6, true) === entries.length &&
        end.getUint32(8, true) === centralSize &&
        end.getUint32(12, true) === central &&
        end.getUint16(16, true) === 0,
    );
    requireZip((await stream.finish()) === sha256, "OBJECT_DIGEST_MISMATCH");
    return {
      format: "zip",
      schema: "neuro-software-package-v1",
      kind: "application",
      fileCount: manifest.length,
      totalUnpackedBytes: total,
      files: entries.slice(1).map(({ path, size, sha256 }) => ({ path, size, sha256 })),
      scanStatus: "not_scanned",
      bytesRead: size,
      sha256,
    };
  } finally {
    await stream.close();
  }
}
