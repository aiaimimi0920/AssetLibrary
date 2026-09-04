"use client";

import { useActionState } from "react";
import { decideSubmissionAction, type OperatorActionState } from "@/app/operator/actions";

const initialState: OperatorActionState = {};

export function OperatorReviewForm({ submissionId, idempotencyKey }: {
  submissionId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(decideSubmissionAction, initialState);
  return (
    <form action={action} className="operator-review-form">
      <input type="hidden" name="submission_id" value={submissionId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <label>
        审核决定
        <select name="decision" defaultValue="" required>
          <option value="" disabled>选择明确决定</option>
          <option value="approved">批准当前 revision</option>
          <option value="needs_changes">要求修改</option>
          <option value="rejected">拒绝当前 revision</option>
        </select>
      </label>
      <label>
        决定理由
        <textarea name="reason" rows={6} required maxLength={4_000} />
        <span>理由会进入不可变审核记录；请勿粘贴账号凭据或原始扫描日志。</span>
      </label>
      <fieldset>
        <legend>可选 Finding（首个结构化问题）</legend>
        <div className="operator-finding-grid">
          <label>代码<input name="finding_code" maxLength={100} placeholder="manifest.permission" /></label>
          <label>严重度<select name="finding_severity" defaultValue="warning">
            <option value="info">Info</option><option value="warning">Warning</option><option value="error">Error</option>
          </select></label>
        </div>
        <label>说明<textarea name="finding_message" rows={3} maxLength={2_000} /></label>
      </fieldset>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "正在提交…" : "提交审核决定"}
        </button>
      </div>
    </form>
  );
}
