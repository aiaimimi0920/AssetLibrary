import type { Metadata } from "next";
import { OperatorConsole } from "@/components/operator-console";
import { OperatorGate, type OperatorGateFailure } from "@/components/operator-gate";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listOperatorReviewQueue, type OperatorApiFailure } from "@/lib/operator-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Operator Review Queue", robots: { index: false, follow: false } };

interface OperatorPageProps { searchParams: Promise<Record<string, string | string[] | undefined>> }

function frame(content: React.ReactNode) {
  return <div className="shell"><StoreHeader active="operator" showOperator environmentMark="PRIVATE / OPERATOR" />{content}</div>;
}

function failure(value: OperatorApiFailure): OperatorGateFailure {
  if (["forbidden", "invalid_request", "unauthenticated"].includes(value)) return value as OperatorGateFailure;
  return "api_unavailable";
}

export default async function OperatorPage({ searchParams }: OperatorPageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={session.failure} loginUrl={accountLoginUrl()} />
  </main>);
  const query = await searchParams;
  if (Array.isArray(query.cursor)) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure="invalid_request" />
  </main>);
  const result = await listOperatorReviewQueue(session.session.access_token, {
    cursor: typeof query.cursor === "string" ? query.cursor : undefined,
    limit: 30,
  });
  if (!result.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={failure(result.failure)} />
  </main>);
  return frame(<OperatorConsole items={result.data.items} nextCursor={result.data.next_cursor} />);
}
