import { randomUUID } from "node:crypto";
import type { Metadata } from "next";
import { OperatorGate, type OperatorGateFailure } from "@/components/operator-gate";
import { OperatorSubmission } from "@/components/operator-submission";
import { StoreHeader } from "@/components/store-header";
import { accountLoginUrl, currentAccountSession } from "@/lib/account-session";
import { getOperatorSubmission, type OperatorApiFailure } from "@/lib/operator-api";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const metadata: Metadata = { title: "Operator Submission", robots: { index: false, follow: false } };

interface DetailPageProps { params: Promise<{ submissionId: string }> }

function frame(content: React.ReactNode) {
  return <div className="shell"><StoreHeader active="operator" showOperator environmentMark="PRIVATE / OPERATOR" />{content}</div>;
}

function failure(value: OperatorApiFailure): OperatorGateFailure {
  if (["forbidden", "invalid_request", "not_found", "unauthenticated"].includes(value)) {
    return value as OperatorGateFailure;
  }
  return "api_unavailable";
}

export default async function OperatorSubmissionPage({ params }: DetailPageProps) {
  const session = await currentAccountSession();
  if (!session.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={session.failure} loginUrl={accountLoginUrl()} />
  </main>);
  const { submissionId } = await params;
  const result = await getOperatorSubmission(session.session.access_token, submissionId);
  if (!result.ok) return frame(<main id="main-content" className="console-state-wrap">
    <OperatorGate failure={failure(result.failure)} />
  </main>);
  return frame(<OperatorSubmission detail={result.data} idempotencyKey={randomUUID()} />);
}
