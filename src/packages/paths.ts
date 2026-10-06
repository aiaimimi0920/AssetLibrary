import { ContentRejected } from "../inspections/png";

/** 不修正归档路径；跨平台设备名、分隔符和大小写碰撞必须由调用者拒绝。 */
export function packagePath(value: string): string {
  const parts = value.split("/");
  if (
    value.length > 180 ||
    parts.length > 4 ||
    parts.some(
      (part) =>
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) ||
        part.endsWith(".") ||
        /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
    )
  )
    throw new ContentRejected("ZIP_PATH_INVALID");
  return value;
}
