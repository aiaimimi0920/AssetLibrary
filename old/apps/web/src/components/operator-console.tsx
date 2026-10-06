import Link from "next/link";
import type { OperatorReviewQueueItem } from "@/lib/operator-contracts";

const statusLabel: Record<OperatorReviewQueueItem["submission"]["status"], string> = {
  in_review: "审核中",
  changes_requested: "等待修改",
  approved: "已批准",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

export function OperatorConsole({ items, nextCursor }: {
  items: OperatorReviewQueueItem[];
  nextCursor: string | null;
}) {
  return (
    <main id="main-content" className="operator-layout">
      <aside className="operator-rail" aria-label="审核流程">
        <p className="eyebrow">REVIEW PIPELINE</p>
        <nav><Link aria-current="page" href="/operator">Review Queue<span>{items.length} visible</span></Link>
          <Link href="/operator/moderation">Moderation<span>trust &amp; safety</span></Link></nav>
        <ol>
          <li><strong>01</strong><span>验证外部会话与 Store Role</span></li>
          <li><strong>02</strong><span>核对声明、权限与净化证据</span></li>
          <li><strong>03</strong><span>记录 revision-bound 决定</span></li>
        </ol>
        <p className="console-boundary">账号身份来自 Account Service；队列不暴露对象键、原始扫描证据或账号主体。</p>
      </aside>
      <section className="operator-board" aria-labelledby="operator-title">
        <header className="console-heading">
          <div>
            <p className="eyebrow">OPERATOR CONTROL PLANE</p>
            <h1 id="operator-title">Review Queue</h1>
            <p className="operator-intro">这是固定快照的人工审核队列。翻页期间新提交不会插入当前窗口。</p>
          </div>
          <span className="operator-counter">{items.length.toString().padStart(2, "0")} / PAGE</span>
        </header>
        {items.length === 0 ? (
          <section className="console-empty operator-empty">
            <p className="eyebrow">QUEUE CLEAR</p>
            <h2>当前没有待审核 Submission</h2>
            <p>这是审核 API 返回的真实空快照，不是权限错误或依赖故障。</p>
          </section>
        ) : (
          <div className="operator-queue">
            {items.map((item, index) => (
              <article className="operator-queue-row" key={item.submission.id}>
                <div className="operator-index">{String(index + 1).padStart(2, "0")}</div>
                <div className="operator-queue-copy">
                  <div className="operator-title-line">
                    <h2>{item.package.name}</h2>
                    <span data-state={item.submission.status}>{statusLabel[item.submission.status]}</span>
                  </div>
                  <p>{item.package.summary || "发布者未填写摘要。"}</p>
                  <div className="operator-meta">
                    <span>{item.package.kind.replace("_", " ")}</span>
                    <code>{item.package.publisher.slug}/{item.package.slug}@{item.release_version}</code>
                    <span>REV {item.submission.revision}</span>
                    <span>{item.submission.approval_count}/{item.submission.required_approvals} APPROVALS</span>
                    <time dateTime={item.submitted_at}>{utc(item.submitted_at)} UTC</time>
                  </div>
                </div>
                <Link className="operator-open" href={`/operator/submissions/${item.submission.id}`}>
                  打开审核<span aria-hidden="true"> →</span>
                </Link>
              </article>
            ))}
          </div>
        )}
        {nextCursor ? <Link className="page-next" href={`/operator?cursor=${encodeURIComponent(nextCursor)}`}>
          下一页<span aria-hidden="true"> →</span>
        </Link> : null}
      </section>
    </main>
  );
}
