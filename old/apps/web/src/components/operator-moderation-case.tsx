import Link from "next/link";
import type { OperatorModerationCaseDetail } from "@/lib/operator-moderation-contracts";
import {
  ModerationApprovalForm,
  ModerationProposalForm,
  ModerationResolutionForm,
  type ModerationOperation,
} from "./operator-moderation-forms";

const statusLabel = { open: "待处置", actioned: "处罚已执行", appealed: "申诉待解决", resolved: "案件已解决" } as const;
const actionLabel = { suspend: "Suspend", yank: "Yank", revoke: "Revoke", block: "Block" } as const;

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

function operations(detail: OperatorModerationCaseDetail): ModerationOperation[] {
  const { package: itemPackage, release } = detail.item;
  const values = [
    { value: `suspend|publisher|${itemPackage.publisher.id}`, label: `Suspend Publisher · ${itemPackage.publisher.slug}` },
    { value: `suspend|package|${itemPackage.id}`, label: `Suspend Package · ${itemPackage.slug}` },
    { value: `block|publisher|${itemPackage.publisher.id}`, label: `Block Publisher · ${itemPackage.publisher.slug}` },
    { value: `block|package|${itemPackage.id}`, label: `Block Package · ${itemPackage.slug}` },
  ];
  if (release) values.push(
    { value: `yank|release|${release.id}`, label: `Yank Release · v${release.version}` },
    { value: `block|release|${release.id}`, label: `Block Release · v${release.version}` },
  );
  return values;
}

export function OperatorModerationCase({ detail, idempotencyKeys }: {
  detail: OperatorModerationCaseDetail;
  idempotencyKeys: { propose: string; approve: string; resolve: string };
}) {
  const action = detail.actions[0];
  return <main id="main-content" className="operator-detail moderation-detail">
    <header className="operator-detail-heading"><div>
      <p className="eyebrow">MODERATION CASE / {detail.item.id}</p>
      <h1>{detail.item.package.name}</h1>
      <p>{detail.item.package.publisher.display_name} · {detail.item.release ? `v${detail.item.release.version}` : "Package-wide report"}</p>
    </div><Link className="secondary-link" href="/operator/moderation">返回案件队列</Link></header>

    <section className="operator-evidence moderation-report" aria-labelledby="report-title">
      <div className="operator-evidence-copy"><p className="eyebrow">SANITIZED REPORT</p>
        <h2 id="report-title">举报事实</h2><p className="moderation-report-reason">{detail.report_reason}</p>
        {detail.evidence_urls.length ? <ul className="moderation-links">{detail.evidence_urls.map((url) => (
          <li key={url}><a href={url} target="_blank" rel="noreferrer noopener">外部证据 · {url}</a></li>
        ))}</ul> : <p className="operator-muted">举报未附外部证据链接。</p>}
      </div><div className="operator-progress"><strong>{detail.item.status === "appealed" ? "!" : "•"}</strong>
        <span>CASE STATE</span><p data-state={detail.item.status}>{statusLabel[detail.item.status]}</p></div>
    </section>

    <div className="operator-detail-grid">
      <section className="operator-detail-panel"><p className="eyebrow">TARGET SCOPE</p><h2>关联范围</h2>
        <dl className="moderation-facts"><div><dt>Publisher</dt><dd><code>{detail.item.package.publisher.slug}</code></dd></div>
          <div><dt>Package</dt><dd><code>{detail.item.package.slug}</code></dd></div>
          <div><dt>Release</dt><dd>{detail.item.release ? <code>{detail.item.release.version}</code> : "全部版本"}</dd></div>
          <div><dt>Reported</dt><dd><time dateTime={detail.item.created_at}>{utc(detail.item.created_at)} UTC</time></dd></div></dl>
      </section>
      <section className="operator-detail-panel"><p className="eyebrow">ACTION RECORD</p><h2>处罚记录</h2>
        {action ? <article className="moderation-action-record"><div><strong>{actionLabel[action.action]}</strong>
          <span data-action-state={action.status}>{action.status}</span></div>
          <code>{action.target_type}:{action.target_ref}</code><p>{action.reason}</p>
          <time dateTime={action.created_at}>Proposed {utc(action.created_at)} UTC</time>
          {action.applied_at ? <time dateTime={action.applied_at}>Applied {utc(action.applied_at)} UTC</time> : null}
        </article> : <p className="operator-muted">尚未记录处罚提案。</p>}
      </section>
    </div>

    {detail.appeal ? <section className="moderation-appeal"><p className="eyebrow">PUBLISHER APPEAL</p>
      <h2>申诉材料</h2><p>{detail.appeal.reason}</p>
      {detail.appeal.resolution ? <p><strong>结论：{detail.appeal.resolution}</strong><br />{detail.appeal.resolution_reason}</p> : null}
    </section> : null}

    <section className="operator-action" aria-labelledby="moderation-action-title"><div>
      <p className="eyebrow">TRANSACTIONAL ACTION</p><h2 id="moderation-action-title">下一步</h2>
      <p>服务端会重新校验角色、案件状态、目标归属、双人隔离和 Blocklist。</p></div>
      {detail.can_propose ? <ModerationProposalForm caseId={detail.item.id}
        idempotencyKey={idempotencyKeys.propose} operations={operations(detail)} />
        : action?.status === "proposed" && action.can_approve
          ? <ModerationApprovalForm caseId={detail.item.id} actionId={action.id} idempotencyKey={idempotencyKeys.approve} />
          : detail.can_resolve
            ? <ModerationResolutionForm caseId={detail.item.id} idempotencyKey={idempotencyKeys.resolve} />
            : <p className="operator-locked">当前身份或案件状态没有可执行动作。处罚提案者不能批准自己的提案。</p>}
    </section>
  </main>;
}
