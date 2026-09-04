import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CatalogFailure, EmptyCatalog, PackageList } from "@/components/package-list";
import { StoreHeader } from "@/components/store-header";
import { getPublisher, listPackages } from "@/lib/public-api";

interface PublisherPageProps {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata({ params }: PublisherPageProps): Promise<Metadata> {
  const { slug } = await params;
  const result = await getPublisher(slug);
  if (!result.ok) return { title: "发布者", robots: { index: false, follow: true } };
  return {
    title: result.data.publisher.display_name,
    description: `查看 ${result.data.publisher.display_name} 当前可公开安装的 AssetLibrary 包。`,
    alternates: { canonical: `/publishers/${encodeURIComponent(result.data.publisher.slug)}` },
  };
}

export default async function PublisherPage({ params, searchParams }: PublisherPageProps) {
  const { slug } = await params;
  const query = await searchParams;
  const invalidCursor = Array.isArray(query.cursor);
  const cursor = typeof query.cursor === "string" ? query.cursor : undefined;
  const profile = await getPublisher(slug);
  if (!profile.ok && profile.failure === "not_found") notFound();
  const packages = profile.ok && invalidCursor
    ? { ok: false as const, failure: "invalid_request" as const }
    : profile.ok
    ? await listPackages({ publisher: profile.data.publisher.slug, cursor, limit: 24 })
    : null;

  return (
    <div className="shell">
      <StoreHeader />
      <main id="main-content" className="publisher-main">
        {!profile.ok ? <CatalogFailure failure={profile.failure} /> : <>
          <header className="publisher-heading">
            <p className="eyebrow">PUBLIC PUBLISHER / VERIFIED CATALOG</p>
            <h1>{profile.data.publisher.display_name}</h1>
            <p>发布者标识 <code>{profile.data.publisher.slug}</code>。这里只列出当前通过公开安装门禁的包。</p>
          </header>
          <section className="publisher-catalog" aria-labelledby="publisher-packages">
            <div className="section-heading">
              <div>
                <p className="eyebrow">INSTALLABLE PACKAGES</p>
                <h2 id="publisher-packages">已发布包</h2>
              </div>
              <Link className="secondary-link" href="/">返回全部目录</Link>
            </div>
            {!packages?.ok ? packages ? <CatalogFailure failure={packages.failure} /> : null
              : packages.data.items.length === 0 ? <EmptyCatalog />
              : <PackageList items={packages.data.items} />}
            {packages?.ok && packages.data.next_cursor ? (
              <Link className="page-next" href={`/publishers/${encodeURIComponent(profile.data.publisher.slug)}?cursor=${encodeURIComponent(packages.data.next_cursor)}`} rel="next">
                下一页<span aria-hidden="true"> →</span>
              </Link>
            ) : null}
          </section>
        </>}
      </main>
    </div>
  );
}
