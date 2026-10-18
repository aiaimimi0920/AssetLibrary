import { ContentRejected } from "../inspections/png";

export const largeArchiveLimit = 96_000_000;
export const largeUnpackedLimit = 256 * 1024 * 1024;
export const largeFileLimit = 128 * 1024 * 1024;
export const largeEntryLimit = 65;
class ArchiveReadError extends Error {}

/** 单一顺序消费者；仅保留当前上游分块，不 tee 或缓冲完整归档。 */
export class ArchiveStream {
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  private chunk: Uint8Array = new Uint8Array(0);
  private offset = 0;
  private received = 0;
  private hash = new crypto.DigestStream("SHA-256");
  private writer = this.hash.getWriter();
  private timer: ReturnType<typeof setTimeout>;
  private expired = false;
  position = 0;
  failure: unknown;

  constructor(
    body: ReadableStream<Uint8Array>,
    private expected: number,
  ) {
    this.reader = body.getReader();
    void this.hash.digest.catch(() => {});
    this.timer = setTimeout(() => {
      this.expired = true;
      void this.reader.cancel().catch(() => {});
    }, 90000);
  }

  private async available() {
    while (this.offset === this.chunk.length) {
      let next: ReadableStreamReadResult<Uint8Array>;
      try {
        next = await this.reader.read();
      } catch {
        throw new ArchiveReadError("INSPECTION_READ_FAILED");
      }
      const { value, done } = next;
      if (this.expired) throw new ArchiveReadError("INSPECTION_READ_TIMEOUT");
      if (done) return false;
      this.received += value.length;
      if (this.received > this.expected) throw new ContentRejected("OBJECT_SIZE_MISMATCH");
      await this.writer.write(value);
      this.chunk = value;
      this.offset = 0;
    }
    return true;
  }

  async part(max: number) {
    if (!(await this.available())) throw new ContentRejected("ZIP_STRUCTURE_INVALID");
    const count = Math.min(max, this.chunk.length - this.offset, 65536);
    const result = this.chunk.subarray(this.offset, this.offset + count);
    this.offset += count;
    this.position += count;
    return result;
  }

  async read(size: number) {
    if (!Number.isSafeInteger(size) || size < 0 || size > 32768)
      throw new ContentRejected("ZIP_STRUCTURE_INVALID");
    const result = new Uint8Array(size);
    let at = 0;
    while (at < size) {
      const chunk = await this.part(size - at);
      result.set(chunk, at);
      at += chunk.length;
    }
    return result;
  }

  segment(size: number) {
    let remaining = size;
    return new ReadableStream<Uint8Array>(
      {
        pull: async (controller) => {
          if (!remaining) return controller.close();
          try {
            const chunk = await this.part(remaining);
            remaining -= chunk.length;
            controller.enqueue(chunk);
          } catch (error) {
            this.failure = error;
            throw error;
          }
        },
      },
      { highWaterMark: 0 },
    );
  }

  async finish() {
    if (await this.available()) throw new ContentRejected("ZIP_STRUCTURE_INVALID");
    if (this.position !== this.expected || this.received !== this.expected)
      throw new ContentRejected("OBJECT_SIZE_MISMATCH");
    await this.writer.close();
    return hex(await this.hash.digest);
  }

  async close() {
    clearTimeout(this.timer);
    await this.reader.cancel().catch(() => {});
    this.reader.releaseLock();
    await this.writer.abort().catch(() => {});
    this.writer.releaseLock();
  }
}

export function hex(value: ArrayBuffer) {
  return [...new Uint8Array(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export async function digestEntry(
  source: ReadableStream<Uint8Array>,
  size: number,
  crc: number,
  method: number,
  capture: boolean,
  sourceFailure: () => unknown,
) {
  const body = method === 8 ? source.pipeThrough(new DecompressionStream("deflate-raw")) : source;
  const reader = body.getReader();
  const hash = new crypto.DigestStream("SHA-256");
  void hash.digest.catch(() => {});
  const writer = hash.getWriter();
  const bytes = capture ? new Uint8Array(size) : undefined;
  let count = 0;
  let checksum = 0xffffffff;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (count + value.length > size) throw new ContentRejected("ZIP_DECODE_SIZE_MISMATCH");
      bytes?.set(value, count);
      count += value.length;
      for (const byte of value)
        checksum = (crcTable[(checksum ^ byte) & 255] ?? 0) ^ (checksum >>> 8);
      await writer.write(value);
    }
    if (count !== size) throw new ContentRejected("ZIP_DECODE_SIZE_MISMATCH");
    if ((checksum ^ 0xffffffff) >>> 0 !== crc) throw new ContentRejected("ZIP_CRC_INVALID");
    await writer.close();
    return { sha256: hex(await hash.digest), bytes };
  } catch (error) {
    // 原生解压器可能重包装上游错误；按本地记录保留临时读故障/超时的重试语义。
    if (sourceFailure()) throw sourceFailure();
    if (error instanceof ContentRejected || error instanceof ArchiveReadError) throw error;
    throw new ContentRejected("ZIP_DEFLATE_INVALID");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    await writer.abort().catch(() => {});
    writer.releaseLock();
  }
}
