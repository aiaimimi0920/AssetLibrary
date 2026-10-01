import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CatalogFailure } from "@/components/package-list";
import { ReleaseFailure, ReleaseList, ReleasePagination } from "@/components/release-list";
import { StoreHeader } from "@/components/store-header";
import type { PackageKind } from "@/lib/contracts";
import { getPackage, listPackageReleases } from "@/lib/public-api";
import { discoverablePackage, packageStructuredData } from '@/lib/package-structured-data';
import { publicOrigin } from '@/lib/public-origin';

interface PackagePageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

const kindLabels: Record<PackageKind, string> = {
  art: "ART NODE",
  capability: "CAPABILITY",
  app_update: "APP UPDATE",
};

export async function generateMetadata({ params }: PackagePageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPackage(slug);
  const origin = publicOrigin();
  if (!result.ok || !origin || !discoverablePackage(result.data)) return { title: "包详情", robots: { index: false, follow: true } };
  return {
    title: result.data.name,
    description: result.data.summary,
    alternates: { canonical: `${origin}/packages/${result.data.slug}` },
    openGraph: {
      title: `${result.data.name} | AssetLibrary`,
      description: result.data.summary,
      type: "article",
    },
  };
}

export default async function PackagePage({ params, searchParams }: PackagePageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const invalidCursor = Array.isArray(query.cursor);
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const result = await getPackage(slug);
  if (!result.ok && result.failure === "not_found") notFound();
  const releases = result.ok && invalidCursor
    ? { ok: false as const, failure: "invalid_request" as const }
    : result.ok
    ? await listPackageReleases(result.data.slug, { cursor, limit: 20 })
    : null;
  const structuredData = result.ok ? packageStructuredData(result.data) : undefined;

  return (
    <div className="shell">
      <StoreHeader />
      <main id="main-content" className="detail-main">
        {!result.ok ? <CatalogFailure failure={result.failure} /> : (
          <article className="package-detail">
            {structuredData ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: structuredData }} /> : null}
            <header>
              <p className="eyebrow">{kindLabels[result.data.kind]} / PUBLISHED</p>
              <h1>{result.data.name}</h1>
              <p className="detail-summary">{result.data.summary || "发布者尚未提供摘要。"}</p>
            </header>
            <dl className="identity-grid">
              <div><dt>发布者</dt><dd><Link className="text-link" href={`/publishers/${encodeURIComponent(result.data.publisher.slug)}`}>{result.data.publisher.display_name}</Link></dd></div>
              <div><dt>包标识</dt><dd>{result.data.slug}</dd></div>
              <div><dt>目录状态</dt><dd><span className="verified-mark"><i aria-hidden="true" />已发布</span></dd></div>
              <div><dt>类型</dt><dd>{kindLabels[result.data.kind]}</dd></div>
            </dl>
            {releases?.ok ? <>
              <ReleaseList items={releases.data.items} markLatest={!cursor} publicArtDownload={result.data.kind === 'art'} />
              <ReleasePagination slug={result.data.slug} cursor={releases.data.next_cursor} />
            </> : releases ? <ReleaseFailure failure={releases.failure} /> : null}
            <footer className="detail-actions">
              <Link className="secondary-link" href="/">返回公开目录</Link>
              <Link className="primary-link" href={`/search?q=${encodeURIComponent(result.data.name)}`}>搜索相关包</Link>
            </footer>
          </article>
        )}
      </main>
    </div>
  );
}
