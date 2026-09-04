import type { Metadata } from "next";
import Link from "next/link";
import { CatalogFailure, EmptyCatalog, PackageList } from "@/components/package-list";
import { StoreHeader } from "@/components/store-header";
import { searchPackages } from "@/lib/public-api";

export const metadata: Metadata = {
  title: "搜索",
  alternates: { canonical: "/search" },
  robots: { index: false, follow: true },
};

interface SearchPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export default async function SearchPage({ searchParams }: SearchPageProps) {
  const query = await searchParams;
  const q = single(query.q)?.trim() ?? "";
  const cursor = single(query.cursor);
  const invalid = q.length > 200 || cursor !== undefined && cursor.length > 256;
  const result = q && !invalid ? await searchPackages({ q, cursor, limit: 24 }) : null;

  return (
    <div className="shell">
      <StoreHeader active="search" />
      <main id="main-content" className="store-main compact-main">
        <section className="search-heading" aria-labelledby="search-title">
          <p className="eyebrow">CATALOG / SEARCH</p>
          <h1 id="search-title">搜索已发布包</h1>
          <form className="search" action="/search" role="search">
            <label className="sr-only" htmlFor="search-query">搜索商店</label>
            <input id="search-query" name="q" defaultValue={q} maxLength={200} required placeholder="输入名称、摘要或发布者" />
            <button type="submit">执行搜索</button>
          </form>
        </section>

        <section className="catalog search-results" aria-live="polite" aria-labelledby="results-title">
          <div className="section-heading">
            <div><p className="eyebrow">SEARCH RESULT</p><h2 id="results-title">{q ? `“${q}” 的结果` : "等待搜索"}</h2></div>
            <Link className="text-link" href="/">浏览全部目录</Link>
          </div>
          {invalid ? <CatalogFailure failure="invalid_request" /> : !q ? (
            <section className="state-panel"><h2>输入关键词开始搜索</h2><p>搜索只返回已经发布且当前可见的包。</p></section>
          ) : !result?.ok ? <CatalogFailure failure={result?.failure ?? "unavailable"} />
            : result.data.items.length === 0 ? <EmptyCatalog search /> : <PackageList items={result.data.items} />}
          {result?.ok && result.data.next_cursor ? (
            <Link className="page-next" href={`/search?${new URLSearchParams({ q, cursor: result.data.next_cursor })}`} rel="next">
              下一页<span aria-hidden="true"> →</span>
            </Link>
          ) : null}
        </section>
      </main>
    </div>
  );
}
