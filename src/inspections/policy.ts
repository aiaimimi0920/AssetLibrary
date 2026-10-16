export const policy = "art-png-rgba8-v1";
export const packagePolicy = "art-zip-manifest-v1";
export const scanPolicy = "art-zip-clamav-v1";
export const capabilityPolicy = "capability-zip-clamav-v1";
export const applicationPolicy = "application-zip-clamav-v1";
export const loomArtPolicy = "loom-art-zip-clamav-v1";
export const loomCapabilityPolicy = "loom-capability-zip-clamav-v1";

const kinds = {
  [policy]: "art",
  [packagePolicy]: "art",
  [scanPolicy]: "art",
  [capabilityPolicy]: "capability",
  [applicationPolicy]: "application",
  [loomArtPolicy]: "art",
  [loomCapabilityPolicy]: "capability",
} as const;

export function inspectionKind(value: unknown) {
  return typeof value === "string" && Object.hasOwn(kinds, value)
    ? kinds[value as keyof typeof kinds]
    : null;
}

export function isScanPolicy(value: unknown) {
  return scanPolicies.includes(value as (typeof scanPolicies)[number]);
}

export function isLoomPolicy(value: unknown) {
  return value === loomArtPolicy || value === loomCapabilityPolicy;
}

const scanPolicies = [
  scanPolicy,
  capabilityPolicy,
  applicationPolicy,
  loomArtPolicy,
  loomCapabilityPolicy,
];

/** 只接收源码内的 SQL 列名；策略值来自固定合同，绝不插入请求输入。 */
export function policyKindSql(column: string) {
  return `(CASE ${column} ${Object.entries(kinds)
    .map(([name, kind]) => `WHEN '${name}' THEN '${kind}'`)
    .join(" ")} ELSE NULL END)`;
}

export const scanPoliciesSql = scanPolicies.map((value) => `'${value}'`).join(", ");
