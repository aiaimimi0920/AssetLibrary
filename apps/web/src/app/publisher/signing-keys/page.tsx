import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { PublisherGate, type PublisherGateFailure } from "@/components/publisher-gate";
import { PublisherSigningKeys } from "@/components/publisher-signing-keys";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import {
  listPublisherMemberships,
  listPublisherSigningKeys,
  type PublisherApiFailure,
} from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Publisher 签名密钥",
  robots: { index: false, follow: false },
};

interface PageProps { searchParams: Promise<Record<string, string | string[] | undefined>> }

function frame(content: ReactNode) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />{content}</div>;
}

function gate(failure: PublisherGateFailure, loginUrl?: string | null) {
  return frame(<main id="main-content" className="console-state-wrap">
    <PublisherGate failure={failure} loginUrl={loginUrl} />
  </main>);
}

function apiFailure(value: PublisherApiFailure): PublisherGateFailure {
  if (value === "unauthenticated") return "unauthenticated";
  if (["forbidden", "invalid_request", "not_found"].includes(value)) return "forbidden";
  return "api_unavailable";
}

export default async function PublisherSigningKeysPage({ searchParams }: PageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return gate(session.failure, accountLoginUrl());
  const query = await searchParams;
  if (Array.isArray(query.publisher) || Array.isArray(query.cursor)) return gate("forbidden");
  const memberships = await listPublisherMemberships(session.session.access_token, { limit: 100 });
  if (!memberships.ok) return gate(apiFailure(memberships.failure));
  if (memberships.data.items.length === 0) return gate("forbidden");
  const membership = query.publisher
    ? memberships.data.items.find((item) => item.publisher.id === query.publisher)
    : memberships.data.items[0];
  if (!membership) return gate("forbidden");
  const result = await listPublisherSigningKeys(session.session.access_token, membership.publisher.id, {
    cursor: query.cursor, limit: 30,
  });
  if (!result.ok) return gate(apiFailure(result.failure));
  return frame(<PublisherSigningKeys memberships={memberships.data.items} membership={membership}
    signingKeys={result.data.items} nextCursor={result.data.next_cursor} registerKey={randomUUID()}
    revokeKeys={Object.fromEntries(result.data.items
      .filter((key) => key.status === "active").map((key) => [key.key_id, randomUUID()]))} />);
}
