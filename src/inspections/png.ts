export class ContentRejected extends Error {
  constructor(public code: string) {
    super(code);
  }
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function crc32(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++)
    crc = (crcTable[(crc ^ (bytes[i] ?? 0)) & 255] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** 严格静态 RGBA8 子集，不接受附加元数据、动画、归档或可执行包。 */
function chunks(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (signature.some((byte, i) => bytes[i] !== byte))
    throw new ContentRejected("PNG_SIGNATURE_INVALID");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const data: Uint8Array[] = [];
  let width = 0;
  let height = 0;
  let offset = 8;
  let count = 0;
  let ended = false;
  while (offset < bytes.length) {
    if (++count > 64 || bytes.length - offset < 12) throw new ContentRejected("PNG_CHUNKS_INVALID");
    const length = view.getUint32(offset);
    if (length > bytes.length - offset - 12) throw new ContentRejected("PNG_CHUNKS_INVALID");
    const type = view.getUint32(offset + 4);
    const end = offset + 8 + length;
    if (crc32(bytes, offset + 4, end) !== view.getUint32(end))
      throw new ContentRejected("PNG_CRC_INVALID");
    if (count === 1 && type === 0x49484452 && length === 13) {
      width = view.getUint32(offset + 8);
      height = view.getUint32(offset + 12);
      if (!width || !height || width > 2048 || height > 2048 || width * height > 1048576)
        throw new ContentRejected("PNG_DIMENSIONS_UNSUPPORTED");
      if (
        bytes[offset + 16] !== 8 ||
        bytes[offset + 17] !== 6 ||
        bytes[offset + 18] !== 0 ||
        bytes[offset + 19] !== 0 ||
        bytes[offset + 20] !== 0
      )
        throw new ContentRejected("PNG_POLICY_UNSUPPORTED");
    } else if (count > 1 && width && type === 0x49444154)
      data.push(bytes.subarray(offset + 8, end));
    else if (type === 0x49454e44 && length === 0 && data.length) {
      ended = true;
      offset = end + 4;
      break;
    } else throw new ContentRejected("PNG_POLICY_UNSUPPORTED");
    offset = end + 4;
  }
  if (!ended || offset !== bytes.length) throw new ContentRejected("PNG_CHUNKS_INVALID");
  return { width, height, data };
}

async function scanlines(data: Uint8Array[], width: number, height: number): Promise<number> {
  const stride = width * 4 + 1;
  const expected = stride * height;
  const input = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of data) controller.enqueue(part);
      controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("deflate")).getReader();
  let seen = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (seen + value.byteLength > expected) throw new ContentRejected("PNG_DECODE_SIZE_MISMATCH");
      for (let i = (stride - (seen % stride)) % stride; i < value.length; i += stride)
        if ((value[i] ?? 255) > 4) throw new ContentRejected("PNG_FILTER_INVALID");
      seen += value.byteLength;
    }
    if (seen !== expected) throw new ContentRejected("PNG_DECODE_SIZE_MISMATCH");
    return seen;
  } catch (error) {
    if (error instanceof ContentRejected) throw error;
    throw new ContentRejected("PNG_DEFLATE_INVALID");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function inspectPng(bytes: Uint8Array, pixelBudget = 1048576) {
  const { width, height, data } = chunks(bytes);
  if (width * height > pixelBudget) throw new ContentRejected("PNG_PIXEL_BUDGET_EXCEEDED");
  const decodedBytes = await scanlines(data, width, height);
  return { format: "png", width, height, bitDepth: 8, colorType: 6, decodedBytes };
}
