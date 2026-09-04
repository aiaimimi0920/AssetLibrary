import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { PublisherGate } from "@/components/publisher-gate";
import { PublisherPackageWorkspace } from "@/components/publisher-package-workspace";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { getOwnedPackage, listOwnedReleases, listPublisherMemberships } from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Package 发布工作区", robots: { index: false, follow: false } };

function gated(failure: Parameters<typeof PublisherGate>[0]["failure"]) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />
    <main id="main-content" className="console-state-wrap">
      <PublisherGate failure={failure} loginUrl={accountLoginUrl()} />
    </main></div>;
}

export default async function PublisherPackagePage({ params }: {
  params: Promise<{ packageId: string }>;
}) {
  const session = await currentAccountSession();
  if (!session.ok) return gated(session.failure);
  const { packageId } = await params;
  const ownedPackage = await getOwnedPackage(session.session.access_token, packageId);
  if (!ownedPackage.ok) {
    const denied = ["invalid_request", "forbidden", "not_found"].includes(ownedPackage.failure);
    return gated(denied ? "forbidden" : "api_unavailable");
  }
  const [memberships, releases] = await Promise.all([
    listPublisherMemberships(session.session.access_token, { limit: 100 }),
    listOwnedReleases(session.session.access_token, packageId, { limit: 100 }),
  ]);
  if (!memberships.ok || !releases.ok) {
    const denied = !memberships.ok && memberships.failure === "forbidden"
      || !releases.ok && ["forbidden", "not_found"].includes(releases.failure);
    return gated(denied ? "forbidden" : "api_unavailable");
  }
  const membership = memberships.data.items.find(
    (item) => item.publisher.id === ownedPackage.data.publisher_id && item.publisher_status === "active",
  );
  if (!membership) return gated("forbidden");
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />
    <PublisherPackageWorkspace ownedPackage={ownedPackage.data}
      releases={releases.data.items} membership={membership} editKey={randomUUID()} />
  </div>;
}
