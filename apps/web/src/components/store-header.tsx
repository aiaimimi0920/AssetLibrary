import Link from "next/link";

interface StoreHeaderProps {
  active?: "discover" | "search" | "publisher" | "operator";
  environmentMark?: string;
  showOperator?: boolean;
}

export function StoreHeader({ active, environmentMark = "PUBLIC CATALOG", showOperator = false }: StoreHeaderProps) {
  return (
    <header className="topbar">
      <Link className="brand" href="/" aria-label="AssetLibrary 首页">
        <span className="brand-mark" aria-hidden="true">AL</span>
        <span>AssetLibrary</span>
      </Link>
      <nav aria-label="主导航">
        <Link aria-current={active === "discover" ? "page" : undefined} href="/">发现</Link>
        <Link aria-current={active === "search" ? "page" : undefined} href="/search">搜索</Link>
        <Link aria-current={active === "publisher" ? "page" : undefined} href="/publisher">发布</Link>
        {showOperator ? (
          <Link aria-current={active === "operator" ? "page" : undefined} href="/operator">审核</Link>
        ) : null}
      </nav>
      <span className="environment-mark">{environmentMark}</span>
    </header>
  );
}
