/** HTTP 输入与错误边界；不把数据库或身份库的内部错误返回给客户端。 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
  ) {
    super(code);
  }
}

export function json(body: unknown, status = 200): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
  });
}

export function principalRef(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9:._@-]{1,200}$/.test(value)) {
    throw new HttpError(400, "INVALID_PRINCIPAL");
  }
  return value;
}

export function exactFields(body: Record<string, unknown>, fields: string[]): void {
  if (Object.keys(body).some((key) => !fields.includes(key))) {
    throw new HttpError(400, "UNKNOWN_FIELD");
  }
}

export function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > 2147483646) {
    throw new HttpError(400, "INVALID_REVISION");
  }
  return Number(value);
}

export function title(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.trim().length < 1 ||
    value.length > 200 ||
    /\p{Cc}/u.test(value)
  ) {
    throw new HttpError(400, "INVALID_TITLE");
  }
  return value.trim();
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
    throw new HttpError(415, "JSON_REQUIRED");
  }
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "INVALID_JSON");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 8192) {
        await reader.cancel();
        throw new HttpError(413, "BODY_TOO_LARGE");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  try {
    const body: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "INVALID_JSON");
  }
}
