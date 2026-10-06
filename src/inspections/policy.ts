export const policy = "art-png-rgba8-v1";
export const packagePolicy = "art-zip-manifest-v1";
export const scanPolicy = "art-zip-clamav-v1";
export const capabilityPolicy = "capability-zip-clamav-v1";
export const applicationPolicy = "application-zip-clamav-v1";

const kinds = {
  [policy]: "art",
  [packagePolicy]: "art",
  [scanPolicy]: "art",
  [capabilityPolicy]: "capability",
  [applicationPolicy]: "application",
} as const;

export function inspectionKind(value: unknown) {
  return typeof value === "string" && Object.hasOwn(kinds, value)
    ? kinds[value as keyof typeof kinds]
    : null;
}

export function isScanPolicy(value: unknown) {
  return value === scanPolicy || value === capabilityPolicy || value === applicationPolicy;
}

/** 只接收源码内的 SQL 列名；策略值来自固定合同，绝不插入请求输入。 */
export function policyKindSql(column: string) {
  return `(CASE ${column} ${Object.entries(kinds)
    .map(([name, kind]) => `WHEN '${name}' THEN '${kind}'`)
    .join(" ")} ELSE NULL END)`;
}

export const scanPoliciesSql = [scanPolicy, capabilityPolicy, applicationPolicy]
  .map((value) => `'${value}'`)
  .join(", ");
