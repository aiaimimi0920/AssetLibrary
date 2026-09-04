import Link from "next/link";
import type { PackageKind, PublishedPackage } from "@/lib/contracts";
import type { PublicApiFailure } from "@/lib/public-api";

const kindLabels: Record<PackageKind, string> = {
  art: "ART NODE",
  capability: "CAPABILITY",
  app_update: "APP UPDATE",
};

export function PackageList({ items }: { items: PublishedPackage[] }) {
  return (
    <div className="package-list">
      {items.map((item, index) => (
        <article className="package-row" key={item.id}>
          <span className="package-index">{String(index + 1).padStart(2, "0")}</span>
          <div className="package-copy">
            <div className="package-meta">
              <span className={`kind-mark kind-${item.kind}`}>{kindLabels[item.kind]}</span>
              <Link className="publisher-link" href={`/publishers/${encodeURIComponent(item.publisher.slug)}`}>
                {item.publisher.display_name}
              </Link>
            </div>
            <h3>{item.name}</h3>
            <p>{item.summary || "发布者尚未提供摘要。"}</p>
          </div>
          <div className="package-action">
            <span className="verified-mark"><i aria-hidden="true" />已发布</span>
            <Link href={`/packages/${encodeURIComponent(item.slug)}`}>查看详情<span aria-hidden="true"> ↗</span></Link>
          </div>
        </article>
      ))}
    </div>
  );
}

export function EmptyCatalog({ search = false }: { search?: boolean }) {
  return (
    <section className="state-panel" aria-labelledby="empty-title">
      <p className="eyebrow">EMPTY / VERIFIED</p>
      <h2 id="empty-title">{search ? "没有匹配的已发布包" : "当前分类还没有已发布包"}</h2>
      <p>这是真实目录结果，不会用示例资产填充。可以调整筛选条件后重试。</p>
    </section>
  );
}

export function CatalogFailure({ failure }: { failure: PublicApiFailure }) {
  const invalid = failure === "invalid_request";
  return (
    <section className="state-panel state-error" role="alert" aria-labelledby="error-title">
      <p className="eyebrow">CATALOG / UNAVAILABLE</p>
      <h2 id="error-title">{invalid ? "目录请求无效" : "目录暂时不可用"}</h2>
      <p>
        {invalid
          ? "链接中的筛选或分页参数已失效，请返回目录首页重新开始。"
          : "无法从 AssetLibrary API 取得可验证结果。系统不会把依赖故障伪装成空目录。"}
      </p>
      <Link className="text-link" href="/">返回目录首页</Link>
    </section>
  );
}
