import Link from "next/link";
import { EditPackageForm } from "@/components/publisher-forms";
import type { OwnedPackage, OwnedRelease, PublisherMembership } from "@/lib/publisher-contracts";

const releaseStatus: Record<OwnedRelease["status"], string> = {
  draft: "草稿",
  uploading: "上传中",
  submitted: "已提交",
  in_review: "审核中",
  approved: "已批准",
  published: "已发布",
  rejected: "需处理",
  yanked: "已下架",
};

function timestamp(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium", timeStyle: "short", timeZone: "UTC",
  }).format(new Date(value));
}

export function PublisherPackageWorkspace({ ownedPackage, releases, membership, editKey }: {
  ownedPackage: OwnedPackage;
  releases: OwnedRelease[];
  membership: PublisherMembership;
  editKey: string;
}) {
  const canCreate = membership.publisher_status === "active"
    && ["owner", "maintainer", "release_manager"].includes(membership.role)
    && ["draft", "submitted", "published"].includes(ownedPackage.status);
  const canEdit = membership.publisher_status === "active"
    && ["owner", "maintainer"].includes(membership.role)
    && ownedPackage.status === "draft";
  return (
    <main id="main-content" className="console-form-page package-workspace">
      <header>
        <p className="eyebrow">PACKAGE RELEASE WORKSPACE</p>
        <h1>{ownedPackage.name}</h1>
        <p>{ownedPackage.description || "尚未填写 Package 说明。"}</p>
        <div className="console-facts">
          <code>{ownedPackage.slug}</code><span>{ownedPackage.kind}</span>
          <span data-state={ownedPackage.status}>{ownedPackage.status}</span>
          <span>{ownedPackage.visibility}</span>
        </div>
        <div className="workspace-links">
          <Link className="secondary-link" href={`/publisher?publisher=${ownedPackage.publisher_id}`}>返回工作区</Link>
          {canCreate ? <Link className="primary-link"
            href={`/publisher/packages/${ownedPackage.id}/releases/new?publisher=${ownedPackage.publisher_id}`}>
            创建 Release
          </Link> : null}
        </div>
      </header>
      <section id="package-metadata" aria-labelledby="package-metadata-title">
        <div className="console-section-heading">
          <div><p className="eyebrow">PACKAGE METADATA</p>
            <h2 id="package-metadata-title">包信息</h2></div>
          <span>{canEdit ? "DRAFT / EDITABLE" : "LOCKED"}</span>
        </div>
        {canEdit
          ? <EditPackageForm key={editKey} ownedPackage={ownedPackage} idempotencyKey={editKey} />
          : <div className="release-locked"><h2>Package 元数据已锁定</h2>
            <p>只有 active Owner 或 Maintainer 可以在 Package 仍为 draft 时修改元数据。</p></div>}
      </section>
      <section aria-labelledby="release-history">
        <div className="console-section-heading">
          <div><p className="eyebrow">RELEASE HISTORY</p><h2 id="release-history">版本与供应链状态</h2></div>
          <span>{releases.length} ITEMS</span>
        </div>
        {releases.length === 0 ? <div className="console-empty compact-empty">
          <h2>尚无 Release</h2><p>创建版本后才能上传签名包并进入扫描与审核。</p>
        </div> : <div className="release-workspace-list">
          {releases.map((release) => <article key={release.id} className="release-workspace-row">
            <div><code>v{release.version}</code><span data-state={release.status}>{releaseStatus[release.status]}</span></div>
            <p>{release.permissions.length} permissions · {release.compatibility.products.length} product constraints</p>
            <time dateTime={release.updated_at}>{timestamp(release.updated_at)} UTC</time>
            <Link href={`/publisher/packages/${ownedPackage.id}/releases/${release.id}`}>管理 Release</Link>
          </article>)}
        </div>}
      </section>
    </main>
  );
}
