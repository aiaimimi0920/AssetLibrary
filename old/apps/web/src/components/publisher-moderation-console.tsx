import Link from "next/link";
import type { PublisherModerationCaseItem } from "@/lib/publisher-moderation-contracts";

const statusLabel = { actioned: "可申诉", appealed: "申诉处理中", resolved: "申诉已结案" } as const;
const actionLabel = { suspend: "Suspend", yank: "Yank", revoke: "Revoke", block: "Block" } as const;

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

export function PublisherModerationConsole({ items, nextCursor }: {
  items: PublisherModerationCaseItem[];
  nextCursor: string | null;
}) {
  return <main id="main-content" className="console-layout">
    <aside className="console-rail" aria-label="Publisher 工作区">
      <p className="eyebrow">PUBLISHER WORKSPACE</p><nav>
        <Link href="/publisher"><strong>Packages</strong><span>草稿与版本</span></Link>
        <Link href="/publisher/signing-keys"><strong>Signing Keys</strong><span>公钥与信任</span></Link>
        <Link href="/publisher/moderation" aria-current="page"><strong>Moderation</strong><span>处罚与申诉</span></Link>
      </nav><p className="console-boundary">这里只显示已执行的处罚；举报人、内部操作者和原始证据不会暴露。</p>
    </aside>
    <section className="console-board" aria-labelledby="publisher-moderation-title">
      <header className="console-heading"><div><p className="eyebrow">ENFORCEMENT &amp; APPEALS</p>
        <h1 id="publisher-moderation-title">处罚与申诉</h1><p className="publisher-moderation-lede">
          跨当前账号的全部有效 Publisher 成员关系，按最新案件排序。</p></div></header>
      <div className="console-section-heading"><div><p className="eyebrow">APPLIED CASES</p>
        <h2>可见案件</h2></div><span>{items.length} ITEMS</span></div>
      {items.length === 0 ? <section className="console-empty publisher-moderation-empty">
        <h2>没有已执行的处罚案件</h2><p>这是经过成员权限过滤后的真实空结果；进行中的内部调查不会在这里提前显示。</p>
      </section> : <div className="publisher-case-list">{items.map((item) =>
        <article className="publisher-case-row" key={item.id}>
          <div className="publisher-case-state"><strong>{actionLabel[item.action.action]}</strong>
            <span data-case-state={item.status}>{statusLabel[item.status]}</span></div>
          <div><h3>{item.package.name}</h3><p>{item.action.reason_preview}</p>
            <div className="owned-package-meta"><code>{item.package.slug}</code>
              <span>{item.release ? `v${item.release.version}` : "PACKAGE WIDE"}</span>
              <time dateTime={item.action.applied_at}>{utc(item.action.applied_at)} UTC</time></div></div>
          <Link className="text-link" href={`/publisher/moderation/${item.id}`}>查看案件</Link>
        </article>)}</div>}
      {nextCursor ? <Link className="page-next" href={`/publisher/moderation?${new URLSearchParams({ cursor: nextCursor })}`}>
        下一页<span aria-hidden="true"> →</span></Link> : null}
    </section>
  </main>;
}
