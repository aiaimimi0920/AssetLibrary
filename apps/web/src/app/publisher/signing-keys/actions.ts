"use server";

import { redirect } from "next/navigation";
import { currentAccountSession } from "@/lib/account-session";
import { hasTrustedActionOrigin } from "@/lib/action-origin";
import {
  registerPublisherSigningKey,
  revokePublisherSigningKey,
  type PublisherApiFailure,
} from "@/lib/publisher-api";
import { isCanonicalEd25519PublicKey } from "@/lib/publisher-signing-key-parser";

export interface SigningKeyActionState { error?: string }

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const keyId = /^[a-z0-9][a-z0-9._-]{0,79}$/;

function field(data: FormData, name: string, maximum: number): string | null {
  const value = data.get(name);
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function validIdempotencyKey(value: string | null): value is string {
  return value !== null && value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}

function reason(value: string | null): value is string {
  return value !== null && value.length >= 1 && value.length <= 500 && value.trim() === value
    && !/[\u0000-\u001f\u007f]/.test(value);
}

function failureMessage(failure: PublisherApiFailure): string {
  const messages: Record<PublisherApiFailure, string> = {
    invalid_request: "签名公钥不符合 Publisher API 合同。",
    unauthenticated: "外部账号会话已失效，操作未执行。",
    forbidden: "只有有效工作区的 Owner 或 Maintainer 可以管理签名密钥。",
    not_found: "签名密钥不存在，可能已被其他成员处理。",
    conflict: "密钥标识、公钥或幂等状态发生冲突，请刷新后确认。",
    feature_disabled: "当前部署未启用签名密钥管理。",
    unavailable: "Publisher API 暂时不可用，操作未执行。",
    invalid_response: "Publisher API 返回无效响应，请刷新确认密钥状态。",
  };
  return messages[failure];
}

async function token(): Promise<string | null> {
  const session = await currentAccountSession();
  return session.ok ? session.session.access_token : null;
}

export async function registerSigningKeyAction(
  _state: SigningKeyActionState,
  data: FormData,
): Promise<SigningKeyActionState> {
  const publisherId = field(data, "publisher_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const identifier = field(data, "key_id", 80);
  const publicKey = field(data, "public_key_base64", 44);
  if (!publisherId || !uuid.test(publisherId) || !validIdempotencyKey(idempotencyKey)
    || !identifier || !keyId.test(identifier) || !isCanonicalEd25519PublicKey(publicKey)) {
    return { error: "请填写有效的小写密钥标识和 32 字节 Ed25519 公钥（标准 Base64）。" };
  }
  if (!await hasTrustedActionOrigin()) return { error: "请求来源验证失败，公钥未注册。" };
  const accessToken = await token();
  if (!accessToken) return { error: "外部账号会话不可用，公钥未注册。" };
  const result = await registerPublisherSigningKey(accessToken, publisherId, idempotencyKey, {
    key_id: identifier,
    algorithm: "ed25519",
    public_key_base64: publicKey,
  });
  if (!result.ok) return { error: failureMessage(result.failure) };
  redirect(`/publisher/signing-keys?publisher=${encodeURIComponent(publisherId)}`);
}

export async function revokeSigningKeyAction(
  _state: SigningKeyActionState,
  data: FormData,
): Promise<SigningKeyActionState> {
  const publisherId = field(data, "publisher_id", 36);
  const identifier = field(data, "key_id", 80);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const revokeReason = field(data, "reason", 500);
  if (!publisherId || !uuid.test(publisherId) || !identifier || !keyId.test(identifier)
    || !validIdempotencyKey(idempotencyKey) || !reason(revokeReason)
    || data.get("confirm") !== "yes") {
    return { error: "请填写吊销原因，并确认不可逆吊销。" };
  }
  if (!await hasTrustedActionOrigin()) return { error: "请求来源验证失败，密钥未吊销。" };
  const accessToken = await token();
  if (!accessToken) return { error: "外部账号会话不可用，密钥未吊销。" };
  const result = await revokePublisherSigningKey(
    accessToken, publisherId, identifier, idempotencyKey, revokeReason,
  );
  if (!result.ok) return { error: failureMessage(result.failure) };
  redirect(`/publisher/signing-keys?publisher=${encodeURIComponent(publisherId)}`);
}
