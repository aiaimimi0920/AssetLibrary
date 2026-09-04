import Link from "next/link";
import type { OperatorModerationCaseItem } from "@/lib/operator-moderation-contracts";

const statusLabel = { open: "待处置", actioned: "已执行", appealed: "待处理申诉", resolved: "已解决" } as const;

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

export function OperatorModerationConsole({ items, nextCursor }: {
  items: OperatorModerationCaseItem[]; nextCursor: string | null;
}) {
  return <main id="main-content" className="operator-layout">
    <aside className="operator-rail" aria-label="Operator 工作区">
      <p className="eyebrow">TRUST &amp; SAFETY</p>
      <nav>
        <Link href="/operator">Review Queue<span>submission decisions</span></Link>
        <Link aria-current="page" href="/operator/moderation">Moderation<span>{items.length} active</span></Link>
      </nav>
      <ol>
        <li><strong>01</strong><span>核对举报与目标归属</span></li>
        <li><strong>02</strong><span>双人批准处罚提案</span></li>
        <li><strong>03</strong><span>处理 Publisher 申诉</span></li>
      </ol>
      <p className="console-boundary">列表不包含举报者、提案者或审批者主体，也不返回对象键和原始扫描日志。</p>
    </aside>
    <section className="operator-board" aria-labelledby="moderation-title">
      <header className="console-heading"><div>
        <p className="eyebrow">OPERATOR CONTROL PLANE</p><h1 id="moderation-title">Moderation Cases</h1>
        <p className="operator-intro">未解决案件的固定快照。处罚只有在不同主体完成第二次批准后才生效。</p>
      </div><span className="operator-counter">{items.length.toString().padStart(2, "0")} / PAGE</span></header>
      {items.length === 0 ? <section className="console-empty operator-empty">
        <p className="eyebrow">QUEUE CLEAR</p><h2>当前没有未解决案件</h2>
        <p>这是 Moderation API 返回的真实空快照，不是角色错误或依赖故障。</p>
      </section> : <div className="operator-queue">{items.map((item, index) => (
        <article className="operator-queue-row" key={item.id}>
          <div className="operator-index">{String(index + 1).padStart(2, "0")}</div>
          <div className="operator-queue-copy">
            <div className="operator-title-line"><h2>{item.package.name}</h2>
              <span data-moderation-state={item.status}>{statusLabel[item.status]}</span></div>
            <p>{item.reason_preview}</p>
            <div className="operator-meta"><code>{item.package.publisher.slug}/{item.package.slug}</code>
              <span>{item.release ? `v${item.release.version}` : "PACKAGE-WIDE"}</span>
              <span>{item.action_status ?? "NO ACTION"}</span>
              <time dateTime={item.created_at}>{utc(item.created_at)} UTC</time></div>
          </div>
          <Link className="operator-open" href={`/operator/moderation/${item.id}`}>打开案件<span aria-hidden="true"> →</span></Link>
        </article>
      ))}</div>}
      {nextCursor ? <Link className="page-next" href={`/operator/moderation?cursor=${encodeURIComponent(nextCursor)}`}>
        下一页<span aria-hidden="true"> →</span></Link> : null}
    </section>
  </main>;
}
