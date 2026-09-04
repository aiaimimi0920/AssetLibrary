"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { currentAccountSession } from "@/lib/account-session";
import { hasTrustedActionOrigin } from "@/lib/action-origin";
import {
  createPackage,
  createRelease,
  submitPublisherRelease,
  updatePackage,
  updateRelease,
  type PublisherApiFailure,
} from "@/lib/publisher-api";
import type {
  CreatePackageRequest,
  CreateReleaseRequest,
  PackageVisibility,
  UpdatePackageRequest,
  UpdateReleaseRequest,
} from "@/lib/publisher-contracts";

export interface PublisherActionState { error?: string }

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slugPattern = /^[a-z0-9][a-z0-9-]{0,119}$/;
const tagPattern = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const rfc3339Pattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function field(data: FormData, name: string, maximum: number): string | null {
  const value = data.get(name);
  return typeof value === "string" && value.length <= maximum ? value : null;
}

function list(value: string | null, maximum: number, pattern?: RegExp): string[] | null {
  if (value === null) return null;
  const items = value.split(",").map((item) => item.trim()).filter(Boolean);
  if (items.length > maximum || new Set(items).size !== items.length
    || pattern && items.some((item) => !pattern.test(item))) return null;
  return items;
}

function line(value: string | null, maximum: number, empty = false): value is string {
  return value !== null && value.length <= maximum && (empty || value.length > 0)
    && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

function multiline(value: string | null, maximum: number): value is string {
  return value !== null && value.length <= maximum && value.trim() === value
    && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value);
}

function validIdempotencyKey(value: string | null): value is string {
  return value !== null && value.length >= 8 && value.length <= 200 && /^[\x21-\x7e]+$/.test(value);
}

function actionError(failure: PublisherApiFailure): string {
  const messages: Record<PublisherApiFailure, string> = {
    invalid_request: "提交内容不符合 Publisher API 合同。",
    unauthenticated: "外部账号会话已失效，请重新登录。",
    forbidden: "当前成员角色无权执行这个操作。",
    not_found: "目标 Package 或 Release 不存在，或已不可访问。",
    conflict: "资源版本、Slug、版本号或幂等状态发生冲突，请刷新后重试。",
    feature_disabled: "App Update 发布能力当前尚未启用。",
    unavailable: "Publisher API 暂时不可用，未创建任何草稿。",
    invalid_response: "Publisher API 返回了无效响应，结果已拒绝。",
  };
  return messages[failure];
}

async function accessToken(): Promise<string | null> {
  const session = await currentAccountSession();
  return session.ok ? session.session.access_token : null;
}

export async function createPackageAction(
  _state: PublisherActionState,
  data: FormData,
): Promise<PublisherActionState> {
  const publisherId = field(data, "publisher_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const slug = field(data, "slug", 120);
  const kind = field(data, "kind", 20);
  const visibility = field(data, "visibility", 20);
  const name = field(data, "name", 160);
  const summary = field(data, "summary", 1_000);
  const description = field(data, "description", 100_000);
  const tags = list(field(data, "tags", 2_100), 32, tagPattern);
  if (!publisherId || !uuidPattern.test(publisherId) || !validIdempotencyKey(idempotencyKey)
    || !slug || !slugPattern.test(slug)
    || !["art", "capability", "app_update"].includes(kind ?? "")
    || !["public", "unlisted", "private"].includes(visibility ?? "")
    || !line(name, 160) || !line(summary, 1_000, true)
    || !multiline(description, 100_000) || tags === null) {
    return { error: "请检查必填项、Slug、标签和字段长度。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，未创建草稿。" };
  }
  const token = await accessToken();
  if (!token) return { error: "外部账号会话不可用，未创建草稿。" };
  const request: CreatePackageRequest = {
    slug,
    kind: kind as CreatePackageRequest["kind"],
    visibility: visibility as PackageVisibility,
    name,
    summary,
    description,
    tags,
  };
  const result = await createPackage(token, publisherId, idempotencyKey, request);
  if (!result.ok) return { error: actionError(result.failure) };
  redirect(`/publisher?publisher=${encodeURIComponent(publisherId)}`);
}

export async function createReleaseAction(
  _state: PublisherActionState,
  data: FormData,
): Promise<PublisherActionState> {
  const publisherId = field(data, "publisher_id", 36);
  const packageId = field(data, "package_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const version = field(data, "version", 100);
  const loom = field(data, "loom_requirement", 100);
  const hook = field(data, "hook_requirement", 100);
  const permissions = list(field(data, "permissions", 10_304), 64);
  if (!publisherId || !uuidPattern.test(publisherId) || !packageId || !uuidPattern.test(packageId)
    || !validIdempotencyKey(idempotencyKey) || !version || !semverPattern.test(version)
    || permissions === null || permissions.some((item) => !line(item, 160))
    || !line(loom, 100, true) || !line(hook, 100, true)) {
    return { error: "请检查目标、SemVer、兼容范围和权限列表。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，未创建版本。" };
  }
  const products: CreateReleaseRequest["compatibility"]["products"] = [];
  if (loom) products.push({ name: "loom", version_requirement: loom });
  if (hook) products.push({ name: "hook", version_requirement: hook });
  const token = await accessToken();
  if (!token) return { error: "外部账号会话不可用，未创建版本。" };
  const result = await createRelease(token, packageId, idempotencyKey, {
    version,
    compatibility: { products },
    permissions,
  });
  if (!result.ok) return { error: actionError(result.failure) };
  redirect(`/publisher/packages/${packageId}/releases/${result.data.id}`);
}

export async function updatePackageAction(
  _state: PublisherActionState,
  data: FormData,
): Promise<PublisherActionState> {
  const packageId = field(data, "package_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const expectedUpdatedAt = field(data, "expected_updated_at", 64);
  const visibility = field(data, "visibility", 20);
  const name = field(data, "name", 160);
  const summary = field(data, "summary", 1_000);
  const description = field(data, "description", 100_000);
  const tags = list(field(data, "tags", 2_100), 32, tagPattern);
  if (!packageId || !uuidPattern.test(packageId) || !validIdempotencyKey(idempotencyKey)
    || !expectedUpdatedAt || !rfc3339Pattern.test(expectedUpdatedAt)
    || !Number.isFinite(Date.parse(expectedUpdatedAt))
    || !["public", "unlisted", "private"].includes(visibility ?? "")
    || !line(name, 160) || !line(summary, 1_000, true)
    || !multiline(description, 100_000) || tags === null) {
    return { error: "请检查 Package、并发版本、标签和字段长度。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，Package 未更新。" };
  }
  const token = await accessToken();
  if (!token) return { error: "外部账号会话不可用，Package 未更新。" };
  const request: UpdatePackageRequest = {
    expected_updated_at: expectedUpdatedAt,
    visibility: visibility as PackageVisibility,
    name,
    summary,
    description,
    tags,
  };
  const result = await updatePackage(token, packageId, idempotencyKey, request);
  if (!result.ok) return { error: actionError(result.failure) };
  revalidatePath(`/publisher/packages/${packageId}`);
  redirect(`/publisher/packages/${packageId}`);
}

export async function updateReleaseAction(
  _state: PublisherActionState,
  data: FormData,
): Promise<PublisherActionState> {
  const packageId = field(data, "package_id", 36);
  const releaseId = field(data, "release_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  const expectedUpdatedAt = field(data, "expected_updated_at", 64);
  const loom = field(data, "loom_requirement", 100);
  const hook = field(data, "hook_requirement", 100);
  const permissions = list(field(data, "permissions", 10_304), 64);
  if (!packageId || !uuidPattern.test(packageId) || !releaseId || !uuidPattern.test(releaseId)
    || !validIdempotencyKey(idempotencyKey) || !expectedUpdatedAt
    || !rfc3339Pattern.test(expectedUpdatedAt) || !Number.isFinite(Date.parse(expectedUpdatedAt))
    || permissions === null || permissions.some((item) => !line(item, 160))
    || !line(loom, 100, true) || !line(hook, 100, true)) {
    return { error: "请检查 Release、并发版本、兼容范围和权限列表。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，Release 未更新。" };
  }
  const products: UpdateReleaseRequest["compatibility"]["products"] = [];
  if (loom) products.push({ name: "loom", version_requirement: loom });
  if (hook) products.push({ name: "hook", version_requirement: hook });
  const token = await accessToken();
  if (!token) return { error: "外部账号会话不可用，Release 未更新。" };
  const result = await updateRelease(token, releaseId, idempotencyKey, {
    expected_updated_at: expectedUpdatedAt,
    compatibility: { products },
    permissions,
  });
  if (!result.ok) return { error: actionError(result.failure) };
  redirect(`/publisher/packages/${packageId}/releases/${releaseId}`);
}

export async function submitReleaseAction(
  _state: PublisherActionState,
  data: FormData,
): Promise<PublisherActionState> {
  const packageId = field(data, "package_id", 36);
  const releaseId = field(data, "release_id", 36);
  const artifactId = field(data, "artifact_id", 36);
  const idempotencyKey = field(data, "idempotency_key", 200);
  if (!packageId || !uuidPattern.test(packageId) || !releaseId || !uuidPattern.test(releaseId)
    || !artifactId || !uuidPattern.test(artifactId) || !validIdempotencyKey(idempotencyKey)
    || data.get("confirm") !== "yes") {
    return { error: "请选择已验证的 Artifact，并确认提交审核。" };
  }
  if (!await hasTrustedActionOrigin()) {
    return { error: "请求来源验证失败，Release 未提交审核。" };
  }
  const token = await accessToken();
  if (!token) return { error: "外部账号会话不可用，Release 未提交审核。" };
  const result = await submitPublisherRelease(token, releaseId, idempotencyKey, artifactId);
  if (!result.ok) return { error: actionError(result.failure) };
  redirect(`/publisher/packages/${packageId}/releases/${releaseId}`);
}
