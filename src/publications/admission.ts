import { HttpError } from "../http";
import { admittedScan, type DeploymentEnv, deploymentAdmission } from "../scanner/deployment";
import type { ScanFact } from "../scanner/facts";
import { cloudScanBlocker } from "../scanner/facts";
import type { VersionRow } from "../versions/records";
import { versionSafety } from "../versions/safety";

/** 部署身份与版本内验收记录共同放行；默认空记录继续失败关闭。 */
export function requireDeploymentAdmission(env: DeploymentEnv, scan?: ScanFact | null) {
  const release = deploymentAdmission(env);
  if (!release || (scan !== undefined && !admittedScan(scan, release)))
    throw new HttpError(409, cloudScanBlocker);
  return release;
}

export function requirePublishAdmission(row: VersionRow, env: DeploymentEnv) {
  const safety = versionSafety(row);
  if (!safety.scanCurrent) throw new HttpError(409, safety.blocker ?? cloudScanBlocker);
  return requireDeploymentAdmission(env, safety.scan);
}
