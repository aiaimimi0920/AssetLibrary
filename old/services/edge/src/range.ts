export interface ByteRange {
  offset: number;
  length: number;
  contentRange: string;
}

export class InvalidRange extends Error {}

export function parseRange(value: string | null, size: number): ByteRange | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(size) || size <= 0 || value.includes(",")) {
    throw new InvalidRange("unsupported range");
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match) throw new InvalidRange("malformed range");
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  if (startText === "" && endText === "") throw new InvalidRange("empty range");

  let start: number;
  let end: number;
  if (startText === "") {
    const suffix = parseInteger(endText);
    if (suffix <= 0) throw new InvalidRange("invalid suffix");
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = parseInteger(startText);
    if (start >= size) throw new InvalidRange("range starts after object");
    end = endText === "" ? size - 1 : Math.min(parseInteger(endText), size - 1);
    if (end < start) throw new InvalidRange("range is reversed");
  }
  const length = end - start + 1;
  return { offset: start, length, contentRange: `bytes ${start}-${end}/${size}` };
}

function parseInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new InvalidRange("invalid integer");
  return parsed;
}
