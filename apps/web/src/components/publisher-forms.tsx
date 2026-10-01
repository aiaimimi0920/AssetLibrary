"use client";

import { useActionState, useEffect, useId, useRef, useState } from "react";
import {
  createPackageAction,
  createReleaseAction,
  submitReleaseAction,
  updatePackageAction,
  updateReleaseAction,
  type PublisherActionState,
} from "@/app/publisher/actions";
import type { OwnedPackage, PublicCompatibility } from "@/lib/publisher-contracts";

const initialState: PublisherActionState = {};
type PackageDraft = Record<'name' | 'visibility' | 'summary' | 'description' | 'tags', string>;

export function CreatePackageForm({ publisherId, idempotencyKey }: {
  publisherId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createPackageAction, initialState);
  return (
    <form action={action} className="publisher-form">
      <input type="hidden" name="publisher_id" value={publisherId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <div className="form-grid">
        <label>Package 名称<input name="name" required maxLength={160} autoComplete="off" /></label>
        <label>全局 Slug<input name="slug" required maxLength={120} pattern="[a-z0-9][a-z0-9-]{0,119}" autoComplete="off" /></label>
        <label>类型<select name="kind" defaultValue="art">
          <option value="art">Art Node</option>
          <option value="capability">Capability</option>
          <option value="app_update">App Update（受功能门控制）</option>
        </select></label>
        <label>可见性<select name="visibility" defaultValue="private">
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public（发布后生效）</option>
        </select></label>
      </div>
      <label>摘要<textarea name="summary" rows={3} maxLength={1_000} /></label>
      <label>说明<textarea name="description" rows={9} maxLength={100_000} /></label>
      <label>标签<input name="tags" maxLength={2_100} placeholder="art, workflow, illustration" autoComplete="off" />
        <span>逗号分隔，最多 32 个小写标签。</span>
      </label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "正在创建…" : "创建包草稿"}
        </button>
      </div>
    </form>
  );
}

export function CreateReleaseForm({ packageId, publisherId, idempotencyKey }: {
  packageId: string;
  publisherId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(createReleaseAction, initialState);
  return (
    <form action={action} className="publisher-form">
      <input type="hidden" name="publisher_id" value={publisherId} />
      <input type="hidden" name="package_id" value={packageId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <div className="form-grid">
        <label>语义版本<input name="version" required maxLength={100} placeholder="1.0.0" autoComplete="off" /></label>
        <label>权限声明<input name="permissions" maxLength={10_304} placeholder="filesystem.read-project, network.fetch" autoComplete="off" />
          <span>逗号分隔；声明将进入审核。</span>
        </label>
        <label>Loom 版本范围<input name="loom_requirement" maxLength={100} placeholder=">=0.1.0" autoComplete="off" /></label>
        <label>Hook 版本范围<input name="hook_requirement" maxLength={100} placeholder=">=0.1.0" autoComplete="off" /></label>
      </div>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "正在创建…" : "创建版本草稿"}
        </button>
      </div>
    </form>
  );
}

export function EditPackageForm({ ownedPackage, idempotencyKey }: {
  ownedPackage: OwnedPackage;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(updatePackageAction, initialState);
  // Keep rejected edits only in this mounted editor, never in browser storage.
  const [draft, setDraft] = useState<PackageDraft>(() => ({ name: ownedPackage.name,
    visibility: ownedPackage.visibility, summary: ownedPackage.summary,
    description: ownedPackage.description, tags: ownedPackage.tags.join(', ') }));
  const errorId = useId();
  const error = useRef<HTMLParagraphElement>(null);
  useEffect(() => { if (state.error) error.current?.focus(); }, [state]);
  const update = (field: keyof PackageDraft, value: string) => setDraft(current => ({ ...current, [field]: value }));
  return (
    <form action={action} className="publisher-form" aria-describedby={state.error ? errorId : undefined}>
      <input type="hidden" name="package_id" value={ownedPackage.id} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="expected_updated_at" value={ownedPackage.updated_at} />
      <div className="immutable-field">
        <span>不可变标识</span><code>{ownedPackage.slug} · {ownedPackage.kind}</code>
      </div>
      <div className="form-grid">
        <label>Package 名称<input name="name" required maxLength={160}
          value={draft.name} onChange={event => update('name', event.currentTarget.value)} autoComplete="off" /></label>
        <label>可见性<select name="visibility" value={draft.visibility}
          onChange={event => update('visibility', event.currentTarget.value)}>
          <option value="private">Private</option>
          <option value="unlisted">Unlisted</option>
          <option value="public">Public（发布后生效）</option>
        </select></label>
      </div>
      <label>摘要<textarea name="summary" rows={3} maxLength={1_000}
        value={draft.summary} onChange={event => update('summary', event.currentTarget.value)} /></label>
      <label>说明<textarea name="description" rows={9} maxLength={100_000}
        value={draft.description} onChange={event => update('description', event.currentTarget.value)} /></label>
      <label>标签<input name="tags" maxLength={2_100} value={draft.tags}
        onChange={event => update('tags', event.currentTarget.value)}
        autoComplete="off" /><span>逗号分隔，最多 32 个小写标签。</span></label>
      <p className="form-note">保存时核对更新时间；Slug 与类型不可修改，其他成员的新修改不会被覆盖。</p>
      {state.error ? <p className="form-error" role="alert" id={errorId} ref={error} tabIndex={-1}>{state.error}</p> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "正在保存…" : "保存 Package 草稿"}
        </button>
      </div>
    </form>
  );
}

export function EditReleaseForm({ releaseId, packageId, version, updatedAt, compatibility,
  permissions, idempotencyKey }: {
  releaseId: string;
  packageId: string;
  version: string;
  updatedAt: string;
  compatibility: PublicCompatibility;
  permissions: string[];
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(updateReleaseAction, initialState);
  const loom = compatibility.products.find((item) => item.name === "loom")?.version_requirement ?? "";
  const hook = compatibility.products.find((item) => item.name === "hook")?.version_requirement ?? "";
  return (
    <form action={action} className="publisher-form">
      <input type="hidden" name="package_id" value={packageId} />
      <input type="hidden" name="release_id" value={releaseId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <input type="hidden" name="expected_updated_at" value={updatedAt} />
      <div className="immutable-field">
        <span>不可变语义版本</span><code>{version}</code>
      </div>
      <div className="form-grid">
        <label>权限声明<input name="permissions" maxLength={10_304}
          defaultValue={permissions.join(", ")} autoComplete="off" />
          <span>逗号分隔；修改只允许发生在 draft 状态。</span>
        </label>
        <label>Loom 版本范围<input name="loom_requirement" maxLength={100}
          defaultValue={loom} autoComplete="off" /></label>
        <label>Hook 版本范围<input name="hook_requirement" maxLength={100}
          defaultValue={hook} autoComplete="off" /></label>
      </div>
      <p className="form-note">保存时会核对当前更新时间；其他成员已修改时，本次提交会安全失败而不是覆盖。</p>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <div className="form-actions">
        <button className="primary-button" type="submit" disabled={pending}>
          {pending ? "正在保存…" : "保存 Release 草稿"}
        </button>
      </div>
    </form>
  );
}

export function SubmitArtifactForm({ packageId, releaseId, artifactId, idempotencyKey }: {
  packageId: string;
  releaseId: string;
  artifactId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(submitReleaseAction, initialState);
  return (
    <form action={action} className="artifact-submit-form">
      <input type="hidden" name="package_id" value={packageId} />
      <input type="hidden" name="release_id" value={releaseId} />
      <input type="hidden" name="artifact_id" value={artifactId} />
      <input type="hidden" name="idempotency_key" value={idempotencyKey} />
      <label className="confirm-check">
        <input type="checkbox" name="confirm" value="yes" required />
        我确认将这个已验证 Artifact 提交审核；提交后 Release 元数据将锁定。
      </label>
      {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
      <button className="primary-button" type="submit" disabled={pending}>
        {pending ? "正在提交…" : "提交 Artifact 审核"}
      </button>
    </form>
  );
}
