"use server";

import { redirect } from "next/navigation";
import { currentAccountSession } from "@/lib/account-session";
import { hasTrustedActionOrigin } from "@/lib/action-origin";
import { decideOperatorSubmission, type OperatorApiFailure } from "@/lib/operator-api";
import type { DecideReviewRequest } from "@/lib/operator-contracts";

export interface OperatorActionState { error?: string }
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function field(data: FormData, name: string, maximum: number): string | null {
  const value = data.get(name);
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function line(value: string | null, maximum: number, empty = false): value is string {
  return value !== null && (empty || value.length > 0) && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function multiline(value: string | null, maximum: number, empty = false): value is string {
  return value !== null && (empty || value.length > 0) && value.length <= maximum
    && value.trim() === value && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function message(failure: OperatorApiFailure): string {
  const values: Record<OperatorApiFailure, string> = {
    invalid_request: "审核决定不符合 API 合同。",
    unauthenticated: "外部账号会话已失效，未提交决定。",
    forbidden: "当前账号不能审核这个 Submission。",
    not_found: "目标 Submission 已不存在。",
    conflict: "Submission 状态或当前 revision 已发生变化，请刷新后重试。",
    unavailable: "审核 API 暂时不可用，未提交决定。",
    invalid_response: "审核 API 返回无效响应，请刷新确认状态。",
  };
  return values[failure];
}

export async function decideSubmissionAction(
  _state: OperatorActionState,
  data: FormData,
): Promise<OperatorActionState> {
  const submissionId = field(data, "submission_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const decision = field(data, "decision", 20);
  const reason = field(data, "reason", 4_000);
  const code = field(data, "finding_code", 100);
  const severity = field(data, "finding_severity", 20);
  const findingMessage = field(data, "finding_message", 2_000);
  const findingPresent = Boolean(code || findingMessage);
  if (!submissionId || !uuidPattern.test(submissionId)
    || !idempotencyKey || idempotencyKey.length < 8 || !/^[\x21-\x7e]+$/.test(idempotencyKey)
    || !["approved", "rejected", "needs_changes"].includes(decision ?? "")
    || !multiline(reason, 4_000)
    || findingPresent && (!line(code, 100) || !multiline(findingMessage, 2_000)
      || !["info", "warning", "error"].includes(severity ?? ""))) {
    return { error: "请检查决定、理由及可选 Finding 的格式与长度。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，未提交决定。" };
  }
  const findings: DecideReviewRequest["findings"] = findingPresent ? [{
    code: code as string,
    severity: severity as DecideReviewRequest["findings"][number]["severity"],
    message: findingMessage as string,
  }] : [];
  const session = await currentAccountSession();
  if (!session.ok) return { error: "外部账号会话不可用，未提交决定。" };
  const result = await decideOperatorSubmission(session.session.access_token, submissionId,
    idempotencyKey, { decision: decision as DecideReviewRequest["decision"], reason, findings });
  if (!result.ok) return { error: message(result.failure) };
  redirect(`/operator/submissions/${submissionId}`);
}
