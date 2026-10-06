import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";

export function inputPath(value) {
  if (
    typeof value !== "string" ||
    value.length > 180 ||
    value.split("/").length > 4 ||
    value
      .split("/")
      .some(
        (part) =>
          !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(part) ||
          part.endsWith(".") ||
          /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part),
      )
  )
    throw new Error("PACKAGE_PATH_INVALID");
  return value;
}

/** 有界读取明确列出的普通文件，绑定路径与已打开对象，拒绝混合快照。 */
export async function readInside(root, name, limit) {
  const filename = path.join(root, inputPath(name));
  const initial = await lstat(filename, { bigint: true });
  if (!initial.isFile() || initial.isSymbolicLink()) throw new Error("PACKAGE_INPUT_NOT_FILE");
  const resolved = await realpath(filename);
  const relative = path.relative(root, resolved);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative))
    throw new Error("PACKAGE_INPUT_OUTSIDE_ROOT");
  const handle = await open(resolved, "r");
  try {
    const stat = await handle.stat({ bigint: true });
    // 绑定实际打开对象，不只相信 open 前解析的路径；源目录仍须由调用者控制。
    if (stat.dev !== initial.dev || stat.ino !== initial.ino)
      throw new Error("PACKAGE_INPUT_CHANGED");
    if (!stat.isFile() || stat.size < 1n || stat.size > BigInt(limit))
      throw new Error("PACKAGE_INPUT_SIZE_LIMIT");
    const bytes = Buffer.alloc(Number(stat.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const final = await handle.stat({ bigint: true });
    if (
      BigInt(size) !== stat.size ||
      final.size !== stat.size ||
      final.mtimeNs !== stat.mtimeNs ||
      final.ctimeNs !== stat.ctimeNs
    )
      throw new Error("PACKAGE_INPUT_CHANGED");
    return bytes.subarray(0, size);
  } finally {
    await handle.close();
  }
}
