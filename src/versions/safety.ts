import { inspectionKind, isScanPolicy } from "../inspections/policy";
import { unscannedPackage } from "../publications/unscanned";
import { admittedScan, type ScannerRelease } from "../scanner/deployment";
import { cloudScanBlocker, parseScanFact, type ScanFact, scanCurrent } from "../scanner/facts";
import { missingContentCheck } from "./policy";
import type { VersionRow } from "./records";

/** 历史 passed/批准不重写；当前准入须匹配随应用版本发布的验收身份。 */
export function versionSafety(row: VersionRow, release: ScannerRelease | null = null) {
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
  const cloudValidated = !!current && release !== null && admittedScan(scan, release);
  const unscanned =
    row.binding_current === 1 &&
    unscannedPackage(row.inspection_policy, row.inspection_result, row.sha256, row.kind);
  return {
    unscanned,
    scan: available ? scan : null,
    scanCurrent: !!current,
    cloudValidated,
    blocker:
      cloudValidated || unscanned
        ? null
        : current
          ? cloudScanBlocker
          : isScanPolicy(row.inspection_policy)
            ? "CONTENT_SCAN_EXPIRED_OR_INVALIDATED"
            : missingContentCheck,
  };
}
