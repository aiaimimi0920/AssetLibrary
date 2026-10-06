/** 仅做扫描预算前置检查，不替代主 Worker 的完整 ZIP/manifest/PNG 策略。
 * ClamAV 可能静默跳过过大条目，不能只靠 exit 0 判定任意归档已完整扫描。
 */
export function withinZipBudget(bytes) {
  if (bytes.length < 22 || bytes.length > 8388608) return false;
  const end = bytes.length - 22;
  if (
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    bytes.readUInt16LE(end + 20) !== 0 ||
    bytes.readUInt32LE(end + 4) !== 0
  )
    return false;
  const count = bytes.readUInt16LE(end + 10);
  if (count < 1 || count > 33 || bytes.readUInt16LE(end + 8) !== count) return false;
  const central = bytes.readUInt32LE(end + 16);
  if (central + bytes.readUInt32LE(end + 12) !== end) return false;
  let at = central;
  let local = 0;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (at + 46 > end || bytes.readUInt32LE(at) !== 0x02014b50) return false;
    const flags = bytes.readUInt16LE(at + 8);
    const method = bytes.readUInt16LE(at + 10);
    const compressed = bytes.readUInt32LE(at + 20);
    const size = bytes.readUInt32LE(at + 24);
    const name = bytes.readUInt16LE(at + 28);
    const next = at + 46 + name;
    total += size;
    if (
      (flags & ~0x800) !== 0 ||
      ![0, 8].includes(method) ||
      size < 1 ||
      size > 1048576 ||
      total > 8388608 ||
      (size > 4096 && size > compressed * 100) ||
      bytes.readUInt32LE(at + 30) !== 0 ||
      bytes.readUInt16LE(at + 34) !== 0 ||
      bytes.readUInt32LE(at + 42) !== local ||
      next > end
    )
      return false;
    if (
      local + 30 + name + compressed > central ||
      bytes.readUInt32LE(local) !== 0x04034b50 ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt32LE(local + 18) !== compressed ||
      bytes.readUInt32LE(local + 22) !== size ||
      bytes.readUInt16LE(local + 26) !== name ||
      bytes.readUInt16LE(local + 28) !== 0
    )
      return false;
    if (!bytes.subarray(local + 30, local + 30 + name).equals(bytes.subarray(at + 46, next)))
      return false;
    local += 30 + name + compressed;
    at = next;
  }
  return at === end && local === central;
}
