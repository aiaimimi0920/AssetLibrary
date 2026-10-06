"use client";

import { useActionState } from "react";
import {
  approveModerationAction,
  proposeModerationAction,
  resolveModerationAppeal,
  type ModerationActionState,
} from "@/app/operator/moderation/actions";

const initial: ModerationActionState = {};
export interface ModerationOperation { value: string; label: string }

export function ModerationProposalForm({ caseId, idempotencyKey, operations }: {
  caseId: string; idempotencyKey: string; operations: ModerationOperation[];
}) {
  const [state, action, pending] = useActionState(proposeModerationAction, initial);
  return <form action={action} className="operator-review-form">
    <input type="hidden" name="case_id" value={caseId} />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <label>处罚目标<select name="operation" defaultValue="" required>
      <option value="" disabled>选择一个有界处罚</option>
      {operations.map((operation) => <option value={operation.value} key={operation.value}>{operation.label}</option>)}
    </select></label>
    <label>提案理由<textarea name="reason" rows={6} maxLength={4_000} required />
      <span>提案本身不生效，必须由另一名 Moderator 或 Operator 独立批准。</span></label>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
    <button className="primary-button" type="submit" disabled={pending}>
      {pending ? "正在记录…" : "记录处罚提案"}
    </button>
  </form>;
}

export function ModerationApprovalForm({ caseId, actionId, idempotencyKey }: {
  caseId: string; actionId: string; idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(approveModerationAction, initial);
  return <form action={action} className="operator-review-form">
    <input type="hidden" name="case_id" value={caseId} />
    <input type="hidden" name="action_id" value={actionId} />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <label className="operator-confirm"><input type="checkbox" name="confirm" value="yes" required />
      <span>我已独立核对举报证据、目标和影响范围；批准后将写入 Blocklist 并立即失效目录。</span></label>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
    <button className="primary-button" type="submit" disabled={pending}>
      {pending ? "正在应用…" : "批准并应用处罚"}
    </button>
  </form>;
}

export function ModerationResolutionForm({ caseId, idempotencyKey }: {
  caseId: string; idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(resolveModerationAppeal, initial);
  return <form action={action} className="operator-review-form">
    <input type="hidden" name="case_id" value={caseId} />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <label>申诉结论<select name="resolution" defaultValue="" required>
      <option value="" disabled>选择结论</option>
      <option value="upheld">维持原处罚</option>
      <option value="block_lifted">解除本案件 Blocklist</option>
    </select></label>
    <label>结论理由<textarea name="reason" rows={6} maxLength={4_000} required />
      <span>解除 Blocklist 不会自动恢复 suspended、yanked 或 revoked 状态。</span></label>
    <label className="operator-confirm"><input type="checkbox" name="confirm" value="yes" required />
      <span>我已核对申诉材料，并理解该结论会写入不可变审计历史。</span></label>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
    <button className="primary-button" type="submit" disabled={pending}>
      {pending ? "正在解决…" : "提交申诉结论"}
    </button>
  </form>;
}
