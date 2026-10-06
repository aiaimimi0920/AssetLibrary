"use client";

import { useActionState } from "react";
import {
  appealModerationCase,
  type PublisherAppealActionState,
} from "@/app/publisher/moderation/actions";

const initialState: PublisherAppealActionState = {};

export function PublisherAppealForm({ caseId, idempotencyKey }: {
  caseId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(appealModerationCase, initialState);
  return <form action={action} className="publisher-form publisher-appeal-form">
    <input type="hidden" name="case_id" value={caseId} />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <label htmlFor="appeal-reason">申诉理由
      <textarea id="appeal-reason" name="reason" required maxLength={4_000} rows={8} />
      <span>说明事实错误、补救措施和希望复核的证据；最多 4,000 字符。</span>
    </label>
    <label className="publisher-confirm">
      <input type="checkbox" name="confirm" value="yes" required />
      <span>我确认提交一次正式申诉；后续修改需要运营流程处理。</span>
    </label>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
    <div className="form-actions"><button className="primary-button" type="submit" disabled={pending}>
      {pending ? "正在提交…" : "提交正式申诉"}
    </button></div>
  </form>;
}
