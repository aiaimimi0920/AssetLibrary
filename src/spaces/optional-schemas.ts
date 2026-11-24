import { hasAssetMarketSchema } from "../assets/taxonomy";
import { hasShowcaseSchema } from "./catalog";

const partialSchemaDbs = new WeakSet<D1Database>();

export function isMissingOptionalTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no such table:\s*(?:resource_profiles|version_profiles|resource_asset_attributes|version_asset_attributes|asset_requests)/i.test(
    message,
  );
}

/**
 * 默认直接按完整 Schema 执行单次 D1 查询，彻底消除每次请求或冷启动时的 sqlite_master 探测往返；
 * 仅在历史增量迁移测试缺少 0013/0014 表时自动回退探测。
 */
export async function withOptionalSchemas<T>(
  db: D1Database,
  run: (showcase: boolean, assetMarket: boolean) => Promise<T>,
): Promise<T> {
  if (partialSchemaDbs.has(db)) {
    const [showcase, assetMarket] = await Promise.all([
      hasShowcaseSchema(db),
      hasAssetMarketSchema(db),
    ]);
    if (showcase && assetMarket) partialSchemaDbs.delete(db);
    return run(showcase, assetMarket);
  }
  try {
    return await run(true, true);
  } catch (error) {
    if (!isMissingOptionalTable(error)) throw error;
    const [showcase, assetMarket] = await Promise.all([
      hasShowcaseSchema(db),
      hasAssetMarketSchema(db),
    ]);
    if (!showcase || !assetMarket) partialSchemaDbs.add(db);
    return run(showcase, assetMarket);
  }
}
