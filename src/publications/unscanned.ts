import { inspectionKind, isFormatPolicy, isLoomPolicy, packagePolicy } from "../inspections/policy";

/** 未扫描是独立事实，不把旧 clean、畸形结果或历史格式结果自动升级为准入。 */
export function unscannedPackage(
  policy: string,
  result: string | null,
  sha256: string,
  kind: string,
) {
  if (!isFormatPolicy(policy) || inspectionKind(policy) !== kind || !result) return false;
  try {
    const value = JSON.parse(result);
    if (
      value.scanStatus !== "not_scanned" ||
      Object.hasOwn(value, "scan") ||
      value.sha256 !== sha256
    )
      return false;
    if (isLoomPolicy(policy)) return value.schema === "loom-native-zip-v1" && value.kind === kind;
    if (policy !== packagePolicy)
      return value.schema === "neuro-software-package-v1" && value.kind === kind;
    return true;
  } catch {
    return false;
  }
}
