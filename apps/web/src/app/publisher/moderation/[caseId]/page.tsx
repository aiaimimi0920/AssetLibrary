import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { PublisherGate, type PublisherGateFailure } from "@/components/publisher-gate";
import { PublisherModerationCase } from "@/components/publisher-moderation-case";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { getPublisherModerationCase, type PublisherApiFailure } from "@/lib/publisher-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Publisher Moderation Case", robots: { index: false, follow: false } };

interface PageProps { params: Promise<{ caseId: string }> }

function frame(content: React.ReactNode) {
  return <div className="shell"><StoreHeader active="publisher" environmentMark="PRIVATE / PUBLISHER" />{content}</div>;
}

function failure(value: PublisherApiFailure): PublisherGateFailure {
  if (value === "unauthenticated") return "unauthenticated";
  if (["forbidden", "invalid_request", "not_found"].includes(value)) return "forbidden";
  return "api_unavailable";
}

export default async function PublisherModerationCasePage({ params }: PageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return frame(<main id="main-content" className="console-state-wrap">
    <PublisherGate failure={session.failure} loginUrl={accountLoginUrl()} />
  </main>);
  const { caseId } = await params;
  const result = await getPublisherModerationCase(session.session.access_token, caseId);
  if (!result.ok) return frame(<main id="main-content" className="console-state-wrap">
    <PublisherGate failure={failure(result.failure)} />
  </main>);
  return frame(<PublisherModerationCase detail={result.data} idempotencyKey={randomUUID()} />);
}
