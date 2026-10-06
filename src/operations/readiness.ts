import { json } from "../http";
import type { IdentityConfig } from "../identity";
import { fixedVerificationKeys } from "../identity/keys";
import { cloudScanBlocker } from "../scanner/facts";
import type { UploadEnv } from "../uploads/records";

const tables = [
  "resources",
  "resource_members",
  "mutation_requests",
  "audit_events",
  "uploads",
  "upload_events",
  "inspections",
  "inspection_events",
  "versions",
  "version_events",
  "publications",
  "publication_events",
  "download_grants",
  "download_grant_events",
  "download_tickets",
];

async function probe(action: () => Promise<boolean>) {
  try {
    return (await action()) ? "available" : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** 仅做固定的只读依赖探测；不公开账号、公钥、业务计数、对象或内部异常。 */
export async function readiness(env: UploadEnv & IdentityConfig) {
  const [identity, database, storage] = await Promise.all([
    probe(async () => {
      if (!env.AUTH_ISSUER || !env.AUTH_AUDIENCE) return false;
      await fixedVerificationKeys(env);
      return true;
    }),
    probe(async () => {
      const row = await env.DB.prepare(`SELECT count(*) AS n FROM sqlite_schema
        WHERE type = 'table' AND name IN (${tables.map(() => "?").join(",")})`)
        .bind(...tables)
        .first<{ n: number }>();
      return row?.n === tables.length;
    }),
    probe(async () => {
      // 保留键不属于任何 quarantine/{resource}/{upload}；缺对象也表示 HEAD 调用成功。
      await env.QUARANTINE.head("__assetlibrary_readiness_probe__");
      return true;
    }),
  ]);
  const ready = [identity, database, storage].every((state) => state === "available");
  return json(
    {
      service: "assetlibrary",
      scope: "private_dependencies",
      status: ready ? "ready" : "degraded",
      checks: { identity, database, storage },
      distribution: { status: "blocked", reason: cloudScanBlocker },
    },
    ready ? 200 : 503,
  );
}
