import { HttpError } from "../http";

/** 单 Range、有限 header 和安全整数；多 Range 不建立 multipart/放大响应。 */
export function downloadRange(request: Request, size: number, etag: string) {
  const value = request.headers.get("range");
  if (!value || request.method === "HEAD") return null;
  const ifRange = request.headers.get("if-range");
  if (ifRange !== null && ifRange !== `"${etag}"`) return null;
  const match = value.length <= 128 ? /^bytes=(\d*)-(\d*)$/.exec(value) : null;
  if (!match || (!match[1] && !match[2])) throw new HttpError(416, "INVALID_RANGE");
  const first = Number(match[1]);
  const last = Number(match[2]);
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last))
    throw new HttpError(416, "INVALID_RANGE");
  const offset = match[1] ? first : Math.max(0, size - last);
  const end = match[1] ? (match[2] ? Math.min(last, size - 1) : size - 1) : size - 1;
  if (offset >= size || end < offset || (!match[1] && last === 0))
    throw new HttpError(416, "INVALID_RANGE");
  return { offset, length: end - offset + 1 };
}
