import type { Metadata } from "next";
import { PublisherGate, type PublisherGateFailure } from "@/components/publisher-gate";
import { PublisherModerationConsole } from "@/components/publisher-moderation-console";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listPublisherModerationCases, type PublisherApiFailure } from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Publisher 处罚与申诉", robots: { index: false, follow: false } };

interface PageProps { searchParams: Promise<Record<string, string | string[] | undefined>> }

function frame(content: React.ReactNode) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />{content}</div>;
}

function failure(value: PublisherApiFailure): PublisherGateFailure {
  if (value === "unauthenticated") return "unauthenticated";
  if (["forbidden", "invalid_request", "not_found"].includes(value)) return "forbidden";
  return "api_unavailable";
}

export default async function PublisherModerationPage({ searchParams }: PageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return frame(<main id="main-content" className="console-state-wrap">
    <PublisherGate failure={session.failure} loginUrl={accountLoginUrl()} />
  </main>);
  const query = await searchParams;
  if (Array.isArray(query.cursor)) return frame(<main id="main-content" className="console-state-wrap">
    <PublisherGate failure="forbidden" />
  </main>);
  const result = await listPublisherModerationCases(session.session.access_token, {
    cursor: query.cursor, limit: 30,
  });
  if (!result.ok) return frame(<main id="main-content" className="console-state-wrap">
    <PublisherGate failure={failure(result.failure)} />
  </main>);
  return frame(<PublisherModerationConsole items={result.data.items} nextCursor={result.data.next_cursor} />);
}
