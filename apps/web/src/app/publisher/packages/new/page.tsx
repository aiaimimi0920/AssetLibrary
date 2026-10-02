import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";
import { CreatePackageForm } from "@/components/publisher-forms";
import { PublisherGate } from "@/components/publisher-gate";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listPublisherMemberships } from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "创建 Package 草稿",
  robots: { index: false, follow: false },
};

interface NewPackagePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function frame(content: ReactNode) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />{content}</div>;
}

export default async function NewPackagePage({ searchParams }: NewPackagePageProps) {
  const session = await currentAccountSession();
  if (!session.ok) {
    return frame(<main id="main-content" className="console-state-wrap">
      <PublisherGate failure={session.failure} loginUrl={accountLoginUrl()} />
    </main>);
  }
  const query = await searchParams;
  const publisherId = typeof query.publisher === "string" ? query.publisher : undefined;
  const memberships = await listPublisherMemberships(session.session.access_token, { limit: 100 });
  if (!memberships.ok) {
    return frame(<main id="main-content" className="console-state-wrap">
      <PublisherGate failure="api_unavailable" />
    </main>);
  }
  const membership = memberships.data.items.find((item) => item.publisher.id === publisherId);
  const authorized = membership?.publisher_status === "active"
    && ["owner", "maintainer"].includes(membership.role);
  if (!membership || !authorized) {
    return frame(<main id="main-content" className="console-state-wrap">
      <PublisherGate failure="forbidden" />
    </main>);
  }

  const idempotencyKey = randomUUID();
  return frame(
    <main id="main-content" className="console-form-page">
      <header>
        <p className="eyebrow">NEW PACKAGE DRAFT</p>
        <h1>创建独立安装包</h1>
        <p>目标工作区：<strong>{membership.publisher.display_name}</strong>。创建后仍需上传、扫描和审核。</p>
        <Link className="secondary-link" href={`/publisher?publisher=${membership.publisher.id}`}>返回工作区</Link>
      </header>
      <CreatePackageForm key={idempotencyKey} publisherId={membership.publisher.id} idempotencyKey={idempotencyKey} />
    </main>,
  );
}
