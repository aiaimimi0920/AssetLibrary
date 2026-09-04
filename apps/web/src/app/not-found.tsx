import Link from "next/link";
import { StoreHeader } from "@/components/store-header";

export default function NotFound() {
  return (
    <div className="shell">
      <StoreHeader />
      <main id="main-content" className="detail-main">
        <section className="state-panel" aria-labelledby="not-found-title">
          <p className="eyebrow">CATALOG / 404</p>
          <h1 id="not-found-title">没有这个已发布包</h1>
          <p>该链接可能无效，或者对应包已不再公开。目录不会展示内部草稿或审核状态。</p>
          <Link className="primary-link" href="/">返回公开目录</Link>
        </section>
      </main>
    </div>
  );
}
