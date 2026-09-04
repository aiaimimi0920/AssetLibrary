import type { Metadata } from "next";
import { PublisherConsole, NoPublisherMemberships } from "@/components/publisher-console";
import { PublisherGate } from "@/components/publisher-gate";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listOwnedPackages, listPublisherMemberships } from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = {
  title: "Publisher Console",
  robots: { index: false, follow: false },
};

interface PublisherPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

function single(value: string | string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function gated(failure: Parameters<typeof PublisherGate>[0]["failure"]) {
  return (
    <div className="shell">
      <StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />
      <main id="main-content" className="console-state-wrap">
        <PublisherGate failure={failure} loginUrl={accountLoginUrl()} />
      </main>
    </div>
  );
}

export default async function PublisherPage({ searchParams }: PublisherPageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return gated(session.failure);

  const memberships = await listPublisherMemberships(session.session.access_token, { limit: 100 });
  if (!memberships.ok) {
    return gated(memberships.failure === "forbidden" ? "forbidden" : "api_unavailable");
  }
  if (memberships.data.items.length === 0) {
    return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" /><NoPublisherMemberships /></div>;
  }

  const query = await searchParams;
  const requestedPublisher = single(query.publisher);
  const cursor = single(query.cursor);
  if (Array.isArray(query.publisher) || Array.isArray(query.cursor)) return gated("forbidden");
  const membership = requestedPublisher
    ? memberships.data.items.find((item) => item.publisher.id === requestedPublisher)
    : memberships.data.items[0];
  if (!membership) return gated("forbidden");

  const packages = await listOwnedPackages(session.session.access_token, membership.publisher.id, {
    cursor,
    limit: 24,
  });
  if (!packages.ok) {
    return gated(packages.failure === "forbidden" ? "forbidden" : "api_unavailable");
  }

  return (
    <div className="shell">
      <StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />
      <PublisherConsole
        memberships={memberships.data.items}
        membership={membership}
        packages={packages.data.items}
        nextCursor={packages.data.next_cursor}
      />
    </div>
  );
}
