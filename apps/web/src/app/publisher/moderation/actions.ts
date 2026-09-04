"use server";

import { redirect } from "next/navigation";
import { currentAccountSession } from "@/lib/account-session";
import { hasTrustedActionOrigin } from "@/lib/action-origin";
import { appealPublisherModerationCase, type PublisherApiFailure } from "@/lib/publisher-api";

export interface PublisherAppealActionState { error?: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function field(data: FormData, name: string, maximum: number): string | null {
  const value = data.get(name);
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function multiline(value: string | null): value is string {
  return value !== null && value.length > 0 && value.trim() === value
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validKey(value: string | null): value is string {
  return value !== null && value.length >= 8 && /^[\x21-\x7e]+$/.test(value);
}

function failureMessage(failure: PublisherApiFailure): string {
  const messages: Record<PublisherApiFailure, string> = {
    invalid_request: "申诉内容不符合 Publisher Moderation API 合同。",
    unauthenticated: "外部账号会话已失效，申诉未提交。",
    forbidden: "当前账号已不是该 Package 的有效 Publisher 成员。",
    not_found: "案件不存在、尚未执行处罚或不属于当前工作区。",
    conflict: "案件已申诉或状态已变化，请刷新后确认。",
    feature_disabled: "当前部署未启用申诉能力。",
    unavailable: "Moderation API 暂时不可用，申诉未提交。",
    invalid_response: "Moderation API 返回无效响应，请刷新确认状态。",
  };
  return messages[failure];
}

export async function appealModerationCase(
  _state: PublisherAppealActionState,
  data: FormData,
): Promise<PublisherAppealActionState> {
  const caseId = field(data, "case_id", 36);
  const key = field(data, "idempotency_key", 200);
  const reason = field(data, "reason", 4_000);
  if (!caseId || !uuid.test(caseId) || !validKey(key) || !multiline(reason)
    || data.get("confirm") !== "yes") {
    return { error: "请填写有效申诉理由并确认提交。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，申诉未提交。" };
  }
  const session = await currentAccountSession();
  if (!session.ok) return { error: "外部账号会话不可用，申诉未提交。" };
  const result = await appealPublisherModerationCase(
    session.session.access_token, caseId, key, reason,
  );
  if (!result.ok) return { error: failureMessage(result.failure) };
  redirect(`/publisher/moderation/${caseId}`);
}
