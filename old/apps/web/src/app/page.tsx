import type { Metadata } from "next";
import Link from "next/link";
import { CatalogFailure, EmptyCatalog, PackageList } from "@/components/package-list";
import { StoreHeader } from "@/components/store-header";
import type { PackageKind } from "@/lib/contracts";
import { listPackages } from "@/lib/public-api";

export const metadata: Metadata = {
  title: "已验证资产与能力",
  alternates: { canonical: "/" },
  openGraph: {
    title: "AssetLibrary / 已验证资产与能力",
    description: "浏览可独立安装、具有明确发布身份的 Neuro Art 与 Capability 包。",
    type: "website",
  },
};

interface HomeProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const filters: Array<{ label: string; value?: PackageKind }> = [
  { label: "全部" },
  { label: "Art Nodes", value: "art" },
  { label: "Capabilities", value: "capability" },
  { label: "App Updates", value: "app_update" },
];

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function packageKind(value: string | undefined): PackageKind | undefined {
  return value === "art" || value === "capability" || value === "app_update" ? value : undefined;
}

export default async function Home({ searchParams }: HomeProps) {
  const query = await searchParams;
  const rawKind = single(query.kind);
  const kind = packageKind(rawKind);
  const cursor = single(query.cursor);
  const result = rawKind && !kind
    ? { ok: false as const, failure: "invalid_request" as const }
    : await listPackages({ kind, cursor, limit: 24 });

  return (
    <div className="shell">
      <StoreHeader active="discover" />
      <main id="main-content" className="store-main">
        <section className="hero" aria-labelledby="hero-title">
          <p className="eyebrow">NEURO / VERIFIED DISTRIBUTION</p>
          <h1 id="hero-title">独立安装，逐项验证。</h1>
          <p className="hero-copy">
            浏览已经进入公开目录的 Art 与 Capability 包。版本字节不会经过网页或核心 API 代理。
          </p>
          <form className="search" action="/search" role="search">
            <label className="sr-only" htmlFor="catalog-search">搜索商店</label>
            <input id="catalog-search" name="q" maxLength={200} required placeholder="搜索节点、能力或发布者" />
            <button type="submit">搜索商店</button>
          </form>
        </section>

        <section className="catalog" aria-labelledby="catalog-title">
          <div className="section-heading">
            <div>
              <p className="eyebrow">PUBLIC CATALOG</p>
              <h2 id="catalog-title">已发布目录</h2>
            </div>
            <nav className="filter-nav" aria-label="包类型筛选">
              {filters.map((filter) => (
                <Link
                  aria-current={filter.value === kind ? "page" : undefined}
                  href={filter.value ? `/?kind=${filter.value}` : "/"}
                  key={filter.label}
                >
                  {filter.label}
                </Link>
              ))}
            </nav>
          </div>
          {!result.ok ? <CatalogFailure failure={result.failure} /> : result.data.items.length === 0
            ? <EmptyCatalog />
            : <PackageList items={result.data.items} />}
          {result.ok && result.data.next_cursor ? (
            <Link className="page-next" href={`/?${new URLSearchParams({
              ...(kind ? { kind } : {}), cursor: result.data.next_cursor,
            })}`} rel="next">下一页<span aria-hidden="true"> →</span></Link>
          ) : null}
        </section>
      </main>
    </div>
  );
}
