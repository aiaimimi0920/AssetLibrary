import type { Metadata } from "next";
import { OperatorGate, type OperatorGateFailure } from "@/components/operator-gate";
import { OperatorModerationConsole } from "@/components/operator-moderation-console";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { listOperatorModerationCases, type OperatorApiFailure } from "@/lib/operator-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Operator Moderation", robots: { index: false, follow: false } };

interface PageProps { searchParams: Promise<Record<string, string | string[] | undefined>> }

function frame(content: React.ReactNode) {
  return <div className="shell"><StoreHeader active="operator" showOperator environmentMark="PRIVATE / OPERATOR" />{content}</div>;
}

function failure(value: OperatorApiFailure): OperatorGateFailure {
  if (["forbidden", "invalid_request", "unauthenticated"].includes(value)) return value as OperatorGateFailure;
  return "api_unavailable";
}

export default async function OperatorModerationPage({ searchParams }: PageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={session.failure} loginUrl={accountLoginUrl()} />
  </main>);
  const query = await searchParams;
  if (Array.isArray(query.cursor)) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure="invalid_request" />
  </main>);
  const result = await listOperatorModerationCases(session.session.access_token, {
    cursor: typeof query.cursor === "string" ? query.cursor : undefined, limit: 30,
  });
  if (!result.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={failure(result.failure)} />
  </main>);
  return frame(<OperatorModerationConsole items={result.data.items} nextCursor={result.data.next_cursor} />);
}
