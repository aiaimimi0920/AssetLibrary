"use client";

import Link from "next/link";
import { useActionState } from "react";
import {
  registerSigningKeyAction,
  revokeSigningKeyAction,
  type SigningKeyActionState,
} from "@/app/publisher/signing-keys/actions";
import type { PublisherMembership } from "@/lib/publisher-contracts";
import type { PublisherSigningKey } from "@/lib/publisher-signing-key-contracts";

const initial: SigningKeyActionState = {};

function utc(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

function RevokeKeyForm({ publisherId, signingKey, idempotencyKey }: {
  publisherId: string;
  signingKey: PublisherSigningKey;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(revokeSigningKeyAction, initial);
  return <form action={action} className="signing-key-revoke-form">
    <input type="hidden" name="publisher_id" value={publisherId} />
    <input type="hidden" name="key_id" value={signingKey.key_id} />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <label>吊销原因<input type="text" name="reason" required maxLength={500} autoComplete="off" /></label>
    <label className="confirm-check"><input type="checkbox" name="confirm" value="yes" required />
      我确认吊销不可逆，并会立即停止依赖此密钥的公开分发。</label>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
    <button className="danger-button" type="submit" disabled={pending}>
      {pending ? "正在吊销…" : "不可逆吊销"}
    </button>
  </form>;
}

function RegisterKeyForm({ publisherId, idempotencyKey }: {
  publisherId: string;
  idempotencyKey: string;
}) {
  const [state, action, pending] = useActionState(registerSigningKeyAction, initial);
  return <form action={action} className="publisher-form signing-key-register-form">
    <input type="hidden" name="publisher_id" value={publisherId} />
    <input type="hidden" name="idempotency_key" value={idempotencyKey} />
    <div className="form-grid">
      <label>密钥标识<input name="key_id" required maxLength={80}
        pattern="[a-z0-9][a-z0-9._-]{0,79}" placeholder="release-2026" autoComplete="off" />
        <span>小写 ASCII；注册后不能改名或替换公钥。</span></label>
      <label>算法<input value="Ed25519" readOnly aria-readonly="true" /></label>
    </div>
    <label>公钥（标准 Base64）<textarea name="public_key_base64" required rows={2}
      minLength={44} maxLength={44} spellCheck={false} autoComplete="off" />
      <span>只粘贴 32 字节 Ed25519 公钥。私钥必须保留在本地或 HSM，绝不能粘贴到这里。</span>
    </label>
    {state.error ? <p className="form-error" role="alert">{state.error}</p> : null}
    <div className="form-actions"><button className="primary-button" type="submit" disabled={pending}>
      {pending ? "正在注册…" : "注册公钥"}
    </button></div>
  </form>;
}

export function PublisherSigningKeys({ memberships, membership, signingKeys, nextCursor,
  registerKey, revokeKeys }: {
  memberships: PublisherMembership[];
  membership: PublisherMembership;
  signingKeys: PublisherSigningKey[];
  nextCursor: string | null;
  registerKey: string;
  revokeKeys: Record<string, string>;
}) {
  const publisher = membership.publisher;
  const canManage = membership.publisher_status === "active"
    && ["owner", "maintainer"].includes(membership.role);
  return <main id="main-content" className="console-layout">
    <aside className="console-rail" aria-label="Publisher 工作区">
      <p className="eyebrow">SIGNING WORKSPACES</p><nav>{memberships.map((item) => <Link
        aria-current={item.publisher.id === publisher.id ? "page" : undefined}
        href={`/publisher/signing-keys?publisher=${item.publisher.id}`} key={item.publisher.id}>
        <strong>{item.publisher.display_name}</strong><span>{item.role} · {item.publisher_status}</span>
      </Link>)}</nav>
      <p className="console-boundary">AssetLibrary 只保存公钥。私钥生命周期完全属于发布者本地工具或 HSM。</p>
    </aside>
    <section className="console-board signing-key-board" aria-labelledby="signing-key-title">
      <header className="console-heading"><div><p className="eyebrow">SUPPLY CHAIN TRUST</p>
        <h1 id="signing-key-title">签名密钥</h1><div className="console-facts">
          <span>{membership.role}</span><span data-state={membership.publisher_status}>{membership.publisher_status}</span>
          <code>{publisher.slug}</code></div></div>
        <Link className="secondary-link" href={`/publisher?publisher=${publisher.id}`}>返回 Packages</Link>
      </header>
      <section className="signing-key-warning" aria-labelledby="private-key-boundary">
        <p className="eyebrow">PRIVATE KEY BOUNDARY</p><h2 id="private-key-boundary">私钥永远不会进入商店</h2>
        <p>请在受控 CLI、硬件密钥或 HSM 中生成并使用私钥；这里只注册可公开验证 Release 的公钥。</p>
      </section>
      {canManage ? <RegisterKeyForm publisherId={publisher.id} idempotencyKey={registerKey} />
        : <p className="pipeline-notice">当前角色可以核验公钥状态，但不能注册或吊销密钥。</p>}
      <div className="console-section-heading"><div><p className="eyebrow">REGISTERED PUBLIC KEYS</p>
        <h2>公钥与吊销状态</h2></div><span>{signingKeys.length} ITEMS</span></div>
      {signingKeys.length === 0 ? <section className="console-empty compact-empty"><h2>尚未注册签名公钥</h2>
        <p>创建可审核的签名 Artifact 前，Owner 或 Maintainer 必须先注册一个 Ed25519 公钥。</p></section>
        : <div className="signing-key-list">{signingKeys.map((key) => <article className="signing-key-card" key={key.key_id}>
          <header><div><h3>{key.key_id}</h3><code>{key.algorithm}</code></div>
            <span data-state={key.status}>{key.status}</span></header>
          <dl><div><dt>SHA-256 指纹</dt><dd><code>{key.fingerprint}</code></dd></div>
            <div><dt>公钥</dt><dd><code>{key.public_key_base64}</code></dd></div>
            <div><dt>注册时间</dt><dd><time dateTime={key.created_at}>{utc(key.created_at)} UTC</time></dd></div>
            {key.revoked_at ? <div><dt>吊销时间</dt><dd><time dateTime={key.revoked_at}>{utc(key.revoked_at)} UTC</time></dd></div> : null}
          </dl>
          {canManage && key.status === "active" ? <RevokeKeyForm publisherId={publisher.id}
            signingKey={key} idempotencyKey={revokeKeys[key.key_id]!} /> : null}
        </article>)}</div>}
      {nextCursor ? <Link className="page-next" href={`/publisher/signing-keys?${new URLSearchParams({
        publisher: publisher.id, cursor: nextCursor,
      })}`}>下一页<span aria-hidden="true"> →</span></Link> : null}
    </section>
  </main>;
}
