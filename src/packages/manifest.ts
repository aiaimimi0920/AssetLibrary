import { ContentRejected } from "../inspections/png";

export function manifestFields(value: unknown, allowed: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).length !== allowed.length ||
    allowed.some((key) => !Object.hasOwn(value, key))
  )
    throw new ContentRejected("PACKAGE_MANIFEST_INVALID");
  return value as Record<string, unknown>;
}

/** 与现有 Art 合同一致的紧凑 JSON；拒绝重复键、BOM 和数字/转义歧义。 */
export function readManifest(bytes: Uint8Array, allowed: string[]) {
  try {
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new Error();
    const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    const body = manifestFields(JSON.parse(text), allowed);
    if (text !== JSON.stringify(body) && text !== `${JSON.stringify(body)}\n`)
      throw new ContentRejected("PACKAGE_MANIFEST_NONCANONICAL");
    return body;
  } catch (error) {
    if (error instanceof ContentRejected) throw error;
    throw new ContentRejected("PACKAGE_MANIFEST_INVALID");
  }
}
