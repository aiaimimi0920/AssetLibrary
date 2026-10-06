import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import { EditReleaseForm } from "@/components/publisher-forms";
import { PublisherGate } from "@/components/publisher-gate";
import { PublisherReleasePipeline } from "@/components/publisher-release-pipeline";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import {
  getOwnedPackage,
  getOwnedRelease,
  getPublisherReleaseWorkspace,
} from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Release 工作区", robots: { index: false, follow: false } };

function gated(failure: Parameters<typeof PublisherGate>[0]["failure"]) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />
    <main id="main-content" className="console-state-wrap">
      <PublisherGate failure={failure} loginUrl={accountLoginUrl()} />
    </main></div>;
}

export default async function PublisherReleasePage({ params }: {
  params: Promise<{ packageId: string; releaseId: string }>;
}) {
  const session = await currentAccountSession();
  if (!session.ok) return gated(session.failure);
  const { packageId, releaseId } = await params;
  const [ownedPackage, release, workspace] = await Promise.all([
    getOwnedPackage(session.session.access_token, packageId),
    getOwnedRelease(session.session.access_token, releaseId),
    getPublisherReleaseWorkspace(session.session.access_token, releaseId),
  ]);
  if (!ownedPackage.ok || !release.ok || !workspace.ok || release.data.package_id !== packageId
    || workspace.data.release_id !== releaseId) {
    const unavailable = !ownedPackage.ok && ["unavailable", "invalid_response"].includes(ownedPackage.failure)
      || !release.ok && ["unavailable", "invalid_response"].includes(release.failure)
      || !workspace.ok && ["unavailable", "invalid_response"].includes(workspace.failure);
    return gated(unavailable ? "api_unavailable" : "forbidden");
  }
  const editKey = randomUUID();
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />
    <main id="main-content" className="console-form-page release-workspace">
      <header>
        <p className="eyebrow">RELEASE CONTROL PLANE</p>
        <h1>{ownedPackage.data.name} <span>v{release.data.version}</span></h1>
        <p>版本号和创建者不可变。兼容范围与权限仅能在 draft 状态编辑。</p>
        <div className="console-facts"><span data-state={release.data.status}>{release.data.status}</span>
          <code>{release.data.id}</code></div>
        <Link className="secondary-link" href={`/publisher/packages/${packageId}`}>返回 Package</Link>
      </header>
      {release.data.status === "draft"
        ? <EditReleaseForm key={editKey} releaseId={release.data.id} packageId={release.data.package_id}
          version={release.data.version} updatedAt={release.data.updated_at}
          compatibility={release.data.compatibility} permissions={release.data.permissions}
          idempotencyKey={editKey} />
        : <section className="release-locked"><h2>Release 元数据已锁定</h2>
          <p>上传或审核开始后不可修改兼容范围和权限；请依据当前供应链状态继续处理。</p></section>}
      <PublisherReleasePipeline packageId={packageId} releaseStatus={release.data.status}
        workspace={workspace.data} />
    </main>
  </div>;
}
