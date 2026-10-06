import { HttpError } from "../http";
import { cloudScanBlocker } from "../scanner/facts";
import type { VersionRow } from "../versions/records";
import { versionSafety } from "../versions/safety";

/** 部署准入仍未验收。无环境开关、请求参数或 seeded publication 放行路径。 */
export function requireDeploymentAdmission(): never {
  throw new HttpError(409, cloudScanBlocker);
}

export function requirePublishAdmission(row: VersionRow) {
  const safety = versionSafety(row);
  if (!safety.scanCurrent) throw new HttpError(409, safety.blocker);
  requireDeploymentAdmission();
}
