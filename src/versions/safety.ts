import { inspectionKind, isScanPolicy } from "../inspections/policy";
import { cloudScanBlocker, parseScanFact, type ScanFact, scanCurrent } from "../scanner/facts";
import { missingContentCheck } from "./policy";
import type { VersionRow } from "./records";

/** 历史 passed/批准不因时间流逝被重写；当前安全准入独立计算，云门禁没有开关。 */
export function versionSafety(row: VersionRow) {
  let scan: ScanFact | null = null;
  try {
    if (row.inspection_result !== null)
      scan = parseScanFact(JSON.parse(row.inspection_result).scan, row.sha256, row.expected_size);
  } catch {
    /* 畸形历史事实失败关闭，不影响历史批准状态的查询。 */
  }
  const available =
    isScanPolicy(row.inspection_policy) &&
    row.kind === inspectionKind(row.inspection_policy) &&
    scan?.verdict === "clean" &&
    scan.sha256 === row.sha256 &&
    scan.size === row.expected_size;
  const current = available && scan !== null && row.binding_current === 1 && scanCurrent(scan);
  return {
    scan: available ? scan : null,
    scanCurrent: !!current,
    cloudValidated: false,
    blocker: current
      ? cloudScanBlocker
      : isScanPolicy(row.inspection_policy)
        ? "CONTENT_SCAN_EXPIRED_OR_INVALIDATED"
        : missingContentCheck,
  };
}
