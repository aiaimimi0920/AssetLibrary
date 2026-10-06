"use server";

import { redirect } from "next/navigation";
import { hasTrustedActionOrigin } from "@/lib/action-origin";
import { currentAccountSession } from "@/lib/account-session";
import type {
  AppealResolution,
  ModerationActionKind,
  ModerationTargetKind,
} from "@/lib/operator-moderation-contracts";
import {
  approveOperatorModerationAction,
  proposeOperatorModerationAction,
  resolveOperatorModerationCase,
  type OperatorApiFailure,
} from "@/lib/operator-api";

export interface ModerationActionState { error?: string }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function field(data: FormData, name: string, maximum: number): string | null {
  const value = data.get(name);
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function multiline(value: string | null, maximum: number): value is string {
  return value !== null && value.length > 0 && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validKey(value: string | null): value is string {
  return value !== null && value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}

function validPair(action: string, target: string): boolean {
  return action === "block" || action === "suspend" && ["publisher", "package"].includes(target)
    || action === "yank" && target === "release"
    || action === "revoke" && ["artifact", "signing_key"].includes(target);
}

function failureMessage(failure: OperatorApiFailure): string {
  const messages: Record<OperatorApiFailure, string> = {
    invalid_request: "操作不符合 Moderation API 合同。",
    unauthenticated: "外部账号会话已失效，操作未提交。",
    forbidden: "当前账号无权执行该操作，或违反双人审批规则。",
    not_found: "Moderation Case 或 Action 已不存在。",
    conflict: "案件、处罚目标或幂等状态已变化，请刷新后重试。",
    unavailable: "Moderation API 暂时不可用，操作未提交。",
    invalid_response: "Moderation API 返回无效响应，请刷新确认状态。",
  };
  return messages[failure];
}

async function accessToken(): Promise<string | null> {
  if (!await hasTrustedActionOrigin()) return null;
  const session = await currentAccountSession();
  return session.ok ? session.session.access_token : null;
}

export async function proposeModerationAction(
  _state: ModerationActionState,
  data: FormData,
): Promise<ModerationActionState> {
  const caseId = field(data, "case_id", 36);
  const key = field(data, "idempotency_key", 200);
  const operation = field(data, "operation", 256)?.split("|");
  const reason = field(data, "reason", 4_000);
  if (!caseId || !uuid.test(caseId) || !validKey(key) || operation?.length !== 3
    || !validPair(operation[0] ?? "", operation[1] ?? "")
    || !operation[2] || operation[2].length > 200 || /[\u0000-\u001f\u007f|]/.test(operation[2])
    || !multiline(reason, 4_000)) return { error: "请检查处罚目标和理由。" };
  const token = await accessToken();
  if (!token) return { error: "请求来源或外部账号会话不可用，操作未提交。" };
  const result = await proposeOperatorModerationAction(token, caseId, key, {
    action: operation[0] as ModerationActionKind,
    target_type: operation[1] as ModerationTargetKind,
    target_ref: operation[2],
    reason,
  });
  if (!result.ok) return { error: failureMessage(result.failure) };
  redirect(`/operator/moderation/${caseId}`);
}

export async function approveModerationAction(
  _state: ModerationActionState,
  data: FormData,
): Promise<ModerationActionState> {
  const caseId = field(data, "case_id", 36);
  const actionId = field(data, "action_id", 36);
  const key = field(data, "idempotency_key", 200);
  if (!caseId || !uuid.test(caseId) || !actionId || !uuid.test(actionId) || !validKey(key)
    || data.get("confirm") !== "yes") return { error: "请确认独立复核后再应用处罚。" };
  const token = await accessToken();
  if (!token) return { error: "请求来源或外部账号会话不可用，操作未提交。" };
  const result = await approveOperatorModerationAction(token, actionId, key);
  if (!result.ok) return { error: failureMessage(result.failure) };
  redirect(`/operator/moderation/${caseId}`);
}

export async function resolveModerationAppeal(
  _state: ModerationActionState,
  data: FormData,
): Promise<ModerationActionState> {
  const caseId = field(data, "case_id", 36);
  const key = field(data, "idempotency_key", 200);
  const resolution = field(data, "resolution", 20);
  const reason = field(data, "reason", 4_000);
  if (!caseId || !uuid.test(caseId) || !validKey(key)
    || !["upheld", "block_lifted"].includes(resolution ?? "") || !multiline(reason, 4_000)
    || data.get("confirm") !== "yes") return { error: "请确认申诉结论并填写理由。" };
  const token = await accessToken();
  if (!token) return { error: "请求来源或外部账号会话不可用，操作未提交。" };
  const result = await resolveOperatorModerationCase(token, caseId, key, {
    resolution: resolution as AppealResolution,
    reason,
  });
  if (!result.ok) return { error: failureMessage(result.failure) };
  redirect(`/operator/moderation/${caseId}`);
}
