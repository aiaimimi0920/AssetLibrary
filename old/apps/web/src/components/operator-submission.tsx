import Link from "next/link";
import type { OperatorSubmissionDetail } from "@/lib/operator-contracts";
import { OperatorReviewForm } from "./operator-review-form";

const decisionLabel = { approved: "批准", rejected: "拒绝", needs_changes: "要求修改" } as const;

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

function bytes(value: number): string {
  if (value < 1_024) return `${value} B`;
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`;
  return `${(value / 1_048_576).toFixed(1)} MiB`;
}

export function OperatorSubmission({ detail, idempotencyKey }: {
  detail: OperatorSubmissionDetail;
  idempotencyKey: string;
}) {
  const { item } = detail;
  return (
    <main id="main-content" className="operator-detail">
      <header className="operator-detail-heading">
        <div>
          <p className="eyebrow">SUBMISSION / REVISION {item.submission.revision}</p>
          <h1>{item.package.name}</h1>
          <p>{item.package.publisher.display_name} · {item.package.kind.replace("_", " ")} · v{item.release_version}</p>
        </div>
        <Link className="secondary-link" href="/operator">返回队列</Link>
      </header>

      <section className="operator-evidence" aria-labelledby="evidence-title">
        <div className="operator-evidence-copy">
          <p className="eyebrow">SANITIZED EVIDENCE</p>
          <h2 id="evidence-title">可审核制品事实</h2>
          <dl>
            <div><dt>SHA-256</dt><dd><code>{detail.evidence.digest}</code></dd></div>
            <div><dt>Size</dt><dd>{bytes(detail.evidence.size_bytes)}</dd></div>
            <div><dt>Media type</dt><dd>{detail.evidence.media_type}</dd></div>
            <div><dt>Policy</dt><dd>{detail.evidence.policy_version}</dd></div>
            <div><dt>Scanner</dt><dd>{item.submission.scanner_version}</dd></div>
            <div><dt>Rules</dt><dd>{item.submission.rule_version}</dd></div>
          </dl>
        </div>
        <div className="operator-progress" aria-label="审批进度">
          <strong>{item.submission.approval_count}/{item.submission.required_approvals}</strong>
          <span>APPROVALS</span>
          <p data-state={item.submission.status}>{item.submission.status.replace("_", " ")}</p>
        </div>
      </section>

      <div className="operator-detail-grid">
        <section className="operator-detail-panel">
          <p className="eyebrow">DECLARATIONS</p><h2>兼容性与权限</h2>
          <h3>Host products</h3>
          {detail.compatibility.products.length ? <ul>{detail.compatibility.products.map((product) => (
            <li key={product.name}><strong>{product.name}</strong><code>{product.version_requirement}</code></li>
          ))}</ul> : <p className="operator-muted">未声明 Host Product 兼容范围。</p>}
          <h3>Permissions</h3>
          {detail.permissions.length ? <ul>{detail.permissions.map((permission) => (
            <li key={permission}><code>{permission}</code></li>
          ))}</ul> : <p className="operator-muted">未声明额外权限。</p>}
        </section>
        <section className="operator-detail-panel">
          <p className="eyebrow">CURRENT REVISION HISTORY</p><h2>审核记录</h2>
          {detail.reviews.length ? <ol className="operator-reviews">{detail.reviews.map((review) => (
            <li key={review.id}>
              <div><strong data-decision={review.decision}>{decisionLabel[review.decision]}</strong>
                <time dateTime={review.decided_at}>{utc(review.decided_at)} UTC</time></div>
              <p>{review.reason || "未记录文字理由。"}</p>
              {review.findings.map((finding) => (
                <p className="operator-finding" data-severity={finding.severity} key={`${review.id}-${finding.code}`}>
                  <code>{finding.code}</code> · {finding.message}
                </p>
              ))}
            </li>
          ))}</ol> : <p className="operator-muted">当前 revision 尚无人工决定。</p>}
        </section>
      </div>

      <section className="operator-action" aria-labelledby="decision-title">
        <div><p className="eyebrow">REVISION-BOUND ACTION</p><h2 id="decision-title">记录审核决定</h2>
          <p>服务端会再次验证角色、自审隔离、Publisher 成员隔离和当前 revision。</p></div>
        {detail.can_review ? (
          <OperatorReviewForm submissionId={item.submission.id} idempotencyKey={idempotencyKey} />
        ) : <p className="operator-locked">当前身份或 Submission 状态不允许新增审核决定。</p>}
      </section>
    </main>
  );
}
