import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CreateReleaseForm } from "@/components/publisher-forms";
import { PublisherGate } from "@/components/publisher-gate";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { getOwnedPackage, listPublisherMemberships } from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "创建 Release 草稿",
  robots: { index: false, follow: false },
};

interface NewReleasePageProps {
  params: Promise<{ packageId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function frame(content: ReactNode) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />{content}</div>;
}

function gate(failure: "forbidden" | "api_unavailable") {
  return frame(<main id="main-content" className="console-state-wrap"><PublisherGate failure={failure} /></main>);
}

export default async function NewReleasePage({ params, searchParams }: NewReleasePageProps) {
  const session = await currentAccountSession();
  if (!session.ok) {
    return frame(<main id="main-content" className="console-state-wrap">
      <PublisherGate failure={session.failure} loginUrl={accountLoginUrl()} />
    </main>);
  }
  const [{ packageId }, query] = await Promise.all([params, searchParams]);
  const publisherId = typeof query.publisher === "string" ? query.publisher : undefined;
  const memberships = await listPublisherMemberships(session.session.access_token, { limit: 100 });
  if (!memberships.ok) return gate("api_unavailable");
  const membership = memberships.data.items.find((item) => item.publisher.id === publisherId);
  const authorized = membership?.publisher_status === "active"
    && ["owner", "maintainer", "release_manager"].includes(membership.role);
  if (!membership || !authorized) return gate("forbidden");

  const packageResult = await getOwnedPackage(session.session.access_token, packageId);
  if (!packageResult.ok) {
    return gate(packageResult.failure === "forbidden" || packageResult.failure === "not_found"
      ? "forbidden" : "api_unavailable");
  }
  const ownedPackage = packageResult.data;
  if (ownedPackage.publisher_id !== membership.publisher.id
    || !["draft", "submitted", "published"].includes(ownedPackage.status)) {
    return gate("forbidden");
  }

  return frame(
    <main id="main-content" className="console-form-page">
      <header>
        <p className="eyebrow">NEW RELEASE DRAFT</p>
        <h1>创建不可变版本</h1>
        <p>目标 Package：<strong>{ownedPackage.name}</strong> <code>{ownedPackage.slug}</code></p>
        <Link className="secondary-link" href={`/publisher?publisher=${membership.publisher.id}`}>返回工作区</Link>
      </header>
      <CreateReleaseForm
        packageId={ownedPackage.id}
        publisherId={membership.publisher.id}
        idempotencyKey={randomUUID()}
      />
    </main>,
  );
}
