import { randomUUID } from "node:crypto";
import { SubmitArtifactForm } from "@/components/publisher-forms";
import { PublisherUploadPanel } from "@/components/publisher-upload-panel";
import type { OwnedReleaseStatus } from "@/lib/publisher-contracts";
import type {
  ArtifactStatus,
  PublisherReleaseWorkspace,
  SubmissionStatus,
} from "@/lib/publisher-workspace-contracts";

const artifactLabels: Record<ArtifactStatus, string> = {
  pending_upload: "等待上传",
  uploaded: "等待扫描",
  scanning: "正在扫描",
  verified: "已验证",
  quarantined: "已隔离",
  deleted: "已删除",
};

const submissionLabels: Record<SubmissionStatus, string> = {
  in_review: "审核中",
  changes_requested: "需要修改",
  approved: "已批准",
  rejected: "已拒绝",
  withdrawn: "已撤回",
};

function canSubmit(status: OwnedReleaseStatus, workspace: PublisherReleaseWorkspace): boolean {
  return ["draft", "uploading", "rejected"].includes(status)
    && (workspace.submission === null
      || ["changes_requested", "rejected", "withdrawn"].includes(workspace.submission.status));
}

export function PublisherReleasePipeline({ packageId, releaseStatus, workspace }: {
  packageId: string;
  releaseStatus: OwnedReleaseStatus;
  workspace: PublisherReleaseWorkspace;
}) {
  const submitReady = canSubmit(releaseStatus, workspace);
  return <section className="release-pipeline" aria-labelledby="pipeline-heading">
    <div className="console-section-heading">
      <div><p className="eyebrow">SUPPLY CHAIN</p><h2 id="pipeline-heading">Artifact 与审核</h2></div>
      <span>{workspace.artifacts.length} ARTIFACTS</span>
    </div>
    {workspace.can_upload ? <PublisherUploadPanel releaseId={workspace.release_id} /> : null}
    {workspace.submission ? <div className="submission-summary">
      <div><span>当前审核</span><strong data-state={workspace.submission.status}>
        {submissionLabels[workspace.submission.status]}</strong></div>
      <div><span>修订</span><strong>R{workspace.submission.revision}</strong></div>
      <div><span>批准进度</span><strong>{workspace.submission.approval_count}
        /{workspace.submission.required_approvals}</strong></div>
    </div> : <p className="pipeline-empty">尚未提交审核。只有扫描通过的 Artifact 才能进入审核队列。</p>}

    {workspace.artifacts.length ? <div className="artifact-list">
      {workspace.artifacts.map((artifact) => <article className="artifact-card" key={artifact.id}>
        <header><div><p className="eyebrow">ARTIFACT</p><h3>{artifact.file_name}</h3></div>
          <span data-state={artifact.status}>{artifactLabels[artifact.status]}</span></header>
        <dl><div><dt>大小</dt><dd>{artifact.size_bytes.toLocaleString("zh-CN")} bytes</dd></div>
          <div><dt>媒体类型</dt><dd>{artifact.media_type}</dd></div>
          <div><dt>期望摘要</dt><dd><code>{artifact.expected_digest ?? "未声明"}</code></dd></div>
          <div><dt>验证摘要</dt><dd><code>{artifact.verified_digest ?? "尚未验证"}</code></dd></div>
          <div><dt>扫描器 / 规则</dt><dd>{artifact.scanner_version && artifact.rule_version
            ? `${artifact.scanner_version} / ${artifact.rule_version}` : "尚无可信扫描结果"}</dd></div></dl>
        {artifact.status === "uploaded" || artifact.status === "scanning"
          ? <p className="artifact-warning">文件仍是不可信输入；扫描、规范化和签名验证全部通过前不能提交。</p>
          : null}
        {artifact.status === "verified" && submitReady
          ? <SubmitArtifactForm packageId={packageId} releaseId={workspace.release_id}
            artifactId={artifact.id} idempotencyKey={randomUUID()} /> : null}
      </article>)}
    </div> : <p className="pipeline-empty">当前 Release 还没有 Artifact。</p>}
    {workspace.artifacts_truncated
      ? <p className="pipeline-notice">仅显示最新 100 个 Artifact；更早记录未载入。</p> : null}

    <section className="review-feedback" aria-labelledby="feedback-heading">
      <h3 id="feedback-heading">审核反馈</h3>
      {workspace.feedback.length ? workspace.feedback.map((entry, index) => <article
        key={`${entry.revision}-${entry.decided_at}-${index}`}>
        <header><strong>R{entry.revision} · {entry.decision}</strong>
          <time dateTime={entry.decided_at}>{new Date(entry.decided_at).toLocaleString("zh-CN")}</time></header>
        {entry.reason ? <p>{entry.reason}</p> : null}
        {entry.findings.length ? <ul>{entry.findings.map((finding, findingIndex) =>
          <li data-severity={finding.severity} key={`${finding.code}-${findingIndex}`}>
            <code>{finding.code}</code> {finding.message}</li>)}</ul> : null}
      </article>) : <p className="pipeline-empty">暂无已决审核反馈。</p>}
      {workspace.feedback_truncated
        ? <p className="pipeline-notice">仅显示最新 100 条已决反馈；更早记录未载入。</p> : null}
    </section>
  </section>;
}
