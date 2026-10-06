import { ContentRejected, crc32 } from "../inspections/png";
import { packagePath } from "./paths";

export const archiveLimit = 8 * 1024 * 1024;
export interface ZipEntry {
  path: string;
  size: number;
  crc: number;
  method: number;
  compressed: Uint8Array;
}

/** 只允许连续 local records + 一一对应的 central directory + 无注释 EOCD。 */
export function parseZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const invalid = () => {
    throw new ContentRejected("ZIP_STRUCTURE_INVALID");
  };
  const range = (at: number, length: number, end = bytes.length) => {
    if (at < 0 || length < 0 || at > end - length) invalid();
  };
  const name = (at: number, length: number) => {
    range(at, length);
    if (!length || length > 180) throw new ContentRejected("ZIP_PATH_INVALID");
    if (bytes.subarray(at, at + length).some((byte) => byte > 127))
      throw new ContentRejected("ZIP_PATH_INVALID");
    try {
      return packagePath(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(at, at + length),
        ),
      );
    } catch (error) {
      if (error instanceof ContentRejected) throw error;
      throw new ContentRejected("ZIP_PATH_INVALID");
    }
  };
  if (bytes.length > archiveLimit) throw new ContentRejected("ZIP_SIZE_LIMIT");
  const end = bytes.length - 22;
  range(end, 22);
  if (
    view.getUint32(end, true) !== 0x06054b50 ||
    view.getUint16(end + 4, true) ||
    view.getUint16(end + 6, true) ||
    view.getUint16(end + 20, true)
  )
    invalid();
  const count = view.getUint16(end + 10, true);
  if (count < 2 || count > 33) throw new ContentRejected("ZIP_ENTRY_LIMIT");
  if (view.getUint16(end + 8, true) !== count) invalid();
  const central = view.getUint32(end + 16, true);
  const centralSize = view.getUint32(end + 12, true);
  if (central + centralSize !== end) invalid();
  range(central, centralSize, end);
  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let at = central;
  let local = 0;
  let total = 0;
  for (let index = 0; index < count; index++) {
    range(at, 46, end);
    if (view.getUint32(at, true) !== 0x02014b50) invalid();
    const needed = view.getUint16(at + 6, true);
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const length = view.getUint16(at + 28, true);
    if (
      (needed !== 10 && needed !== 20) ||
      flags & ~0x800 ||
      (method !== 0 && method !== 8) ||
      (method === 8 && needed !== 20) ||
      view.getUint16(at + 30, true) ||
      view.getUint16(at + 32, true) ||
      view.getUint16(at + 34, true) ||
      view.getUint16(at + 36, true) & ~1
    )
      throw new ContentRejected("ZIP_FEATURE_UNSUPPORTED");
    const host = view.getUint16(at + 4, true) >>> 8;
    const attributes = view.getUint32(at + 38, true);
    const mode = attributes >>> 16;
    if (
      (host !== 0 && host !== 3) ||
      (host === 0 && mode !== 0) ||
      (attributes & 0xffff & ~0x27) !== 0 ||
      (host === 3 && (mode & 0xf000) !== 0 && (mode & 0xf000) !== 0x8000) ||
      mode & 0xe49
    )
      throw new ContentRejected("ZIP_FILE_TYPE_UNSUPPORTED");
    range(at + 46, length, end);
    const path = name(at + 46, length);
    const folded = path.toLowerCase();
    if (
      [...paths].some(
        (prior) =>
          prior === folded || prior.startsWith(`${folded}/`) || folded.startsWith(`${prior}/`),
      )
    )
      throw new ContentRejected("ZIP_PATH_COLLISION");
    paths.add(folded);
    if (index === 0 && path !== "manifest.json")
      throw new ContentRejected("PACKAGE_LAYOUT_INVALID");
    const limit = index === 0 ? 32768 : 1048576;
    total += size;
    if (
      !size ||
      size > limit ||
      total > archiveLimit ||
      (size > 4096 && size > compressedSize * 100)
    )
      throw new ContentRejected("ZIP_EXPANSION_LIMIT");
    if (method === 0 && compressedSize !== size) invalid();
    range(local, 30, central);
    if (
      view.getUint32(local, true) !== 0x04034b50 ||
      view.getUint32(at + 42, true) !== local ||
      view.getUint16(local + 4, true) !== needed ||
      view.getUint16(local + 6, true) !== flags ||
      view.getUint16(local + 8, true) !== method ||
      view.getUint32(local + 10, true) !== view.getUint32(at + 12, true) ||
      view.getUint32(local + 14, true) !== crc ||
      view.getUint32(local + 18, true) !== compressedSize ||
      view.getUint32(local + 22, true) !== size ||
      view.getUint16(local + 26, true) !== length ||
      view.getUint16(local + 28, true)
    )
      invalid();
    range(local + 30, length, central);
    if (name(local + 30, length) !== path) invalid();
    const dataAt = local + 30 + length;
    range(dataAt, compressedSize, central);
    entries.push({
      path,
      size,
      crc,
      method,
      compressed: bytes.subarray(dataAt, dataAt + compressedSize),
    });
    local = dataAt + compressedSize;
    at += 46 + length;
  }
  if (at !== end || local !== central) invalid();
  return entries;
}

export async function entryBytes(entry: ZipEntry): Promise<Uint8Array> {
  let bytes = entry.compressed;
  if (entry.method === 8) {
    const input = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(entry.compressed);
        c.close();
      },
    });
    // 不支持该原生能力属于设施故障，不使用无约束的解压 fallback。
    const reader = input.pipeThrough(new DecompressionStream("deflate-raw")).getReader();
    bytes = new Uint8Array(entry.size);
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        if (size + value.byteLength > entry.size)
          throw new ContentRejected("ZIP_DECODE_SIZE_MISMATCH");
        bytes.set(value, size);
        size += value.byteLength;
      }
      if (size !== entry.size) throw new ContentRejected("ZIP_DECODE_SIZE_MISMATCH");
    } catch (error) {
      if (error instanceof ContentRejected) throw error;
      throw new ContentRejected("ZIP_DEFLATE_INVALID");
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  if (crc32(bytes, 0, bytes.length) !== entry.crc) throw new ContentRejected("ZIP_CRC_INVALID");
  return bytes;
}
