import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { OperatorGate, type OperatorGateFailure } from "@/components/operator-gate";
import { OperatorModerationCase } from "@/components/operator-moderation-case";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { getOperatorModerationCase, type OperatorApiFailure } from "@/lib/operator-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Operator Moderation Case", robots: { index: false, follow: false } };

interface PageProps { params: Promise<{ caseId: string }> }

function frame(content: React.ReactNode) {
  return <div className="shell"><StoreHeader active="operator" showOperator environmentMark="PRIVATE / OPERATOR" />{content}</div>;
}

function failure(value: OperatorApiFailure): OperatorGateFailure {
  if (["forbidden", "invalid_request", "not_found", "unauthenticated"].includes(value)) {
    return value as OperatorGateFailure;
  }
  return "api_unavailable";
}

export default async function OperatorModerationCasePage({ params }: PageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={session.failure} loginUrl={accountLoginUrl()} />
  </main>);
  const { caseId } = await params;
  const result = await getOperatorModerationCase(session.session.access_token, caseId);
  if (!result.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={failure(result.failure)} />
  </main>);
  return frame(<OperatorModerationCase detail={result.data} idempotencyKeys={{
    propose: randomUUID(), approve: randomUUID(), resolve: randomUUID(),
  }} />);
}
