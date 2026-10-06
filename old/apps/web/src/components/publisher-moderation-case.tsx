import Link from "next/link";
import type { PublisherModerationCaseDetail } from "@/lib/publisher-moderation-contracts";
import { PublisherAppealForm } from "./publisher-moderation-form";

const statusLabel = { actioned: "处罚已执行，可申诉", appealed: "申诉等待运营处理", resolved: "申诉已结案" } as const;
const actionLabel = { suspend: "Suspend", yank: "Yank", revoke: "Revoke", block: "Block" } as const;

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

export function PublisherModerationCase({ detail, idempotencyKey }: {
  detail: PublisherModerationCaseDetail;
  idempotencyKey: string;
}) {
  const { item } = detail;
  return <main id="main-content" className="console-form-page publisher-case-detail">
    <header><p className="eyebrow">MODERATION CASE / {item.id}</p><h1>{item.package.name}</h1>
      <p>{item.release ? `Release v${item.release.version}` : "Package-wide action"} · {statusLabel[item.status]}</p>
      <Link className="secondary-link" href="/publisher/moderation">返回处罚与申诉</Link></header>
    <section className="publisher-enforcement-focus" aria-labelledby="enforcement-title">
      <p className="eyebrow">ENFORCEMENT NOTICE</p><h2 id="enforcement-title">
        {actionLabel[item.action.action]} · {item.action.target_type}</h2>
      <p>{detail.action_reason}</p><dl><div><dt>Target</dt><dd><code>{item.action.target_ref}</code></dd></div>
        <div><dt>Applied</dt><dd><time dateTime={item.action.applied_at}>{utc(item.action.applied_at)} UTC</time></dd></div>
        <div><dt>Status</dt><dd>{statusLabel[item.status]}</dd></div></dl>
    </section>
    {detail.appeal ? <section className="publisher-appeal-record" aria-labelledby="appeal-record-title">
      <p className="eyebrow">YOUR APPEAL</p><h2 id="appeal-record-title">已提交申诉</h2><p>{detail.appeal.reason}</p>
      {detail.appeal.resolution ? <div className="publisher-resolution"><strong>
        结论：{detail.appeal.resolution === "upheld" ? "维持处罚" : "解除 Blocklist"}</strong>
        <p>{detail.appeal.resolution_reason}</p></div> : <p className="publisher-pending">状态：等待运营处理</p>}
    </section> : null}
    <section className="publisher-appeal-action" aria-labelledby="appeal-action-title">
      <div><p className="eyebrow">FORMAL APPEAL</p><h2 id="appeal-action-title">下一步</h2>
        <p>申诉只提交一次。解除 Blocklist 不会静默恢复已暂停、下架或撤销的资源。</p></div>
      {detail.can_appeal ? <PublisherAppealForm caseId={item.id} idempotencyKey={idempotencyKey} />
        : <p className="publisher-appeal-locked">当前案件没有可提交的申诉动作。</p>}
    </section>
  </main>;
}
