"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import {
  uploadPublisherFile,
  validateUploadFile,
  type UploadProgress,
} from "@/lib/publisher-upload-client";
import { clearUploadResume, readUploadResume } from "@/lib/publisher-upload-resume";

type Phase = "idle" | "recoverable" | "hashing" | "uploading" | "finalizing" | "complete" | "error";

const phaseLabels: Record<Phase, string> = {
  idle: "等待选择",
  recoverable: "可恢复上传",
  hashing: "本地计算 SHA-256",
  uploading: "直传隔离桶",
  finalizing: "校验完成清单",
  complete: "已进入扫描队列",
  error: "上传未完成",
};

export function PublisherUploadPanel({ releaseId }: { releaseId: string }) {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState<UploadProgress | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [hasResume, setHasResume] = useState(false);
  const busy = ["hashing", "uploading", "finalizing"].includes(phase);

  useEffect(() => {
    if (!readUploadResume(releaseId)) return;
    const timer = window.setTimeout(() => {
      setHasResume(true);
      setPhase("recoverable");
      setMessage("检测到本标签页未完成的上传。重新选择同一 ZIP 后，将校验完整摘要并只补传缺失分片。");
      input.current?.focus();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [releaseId]);

  function updateProgress(value: UploadProgress) {
    setProgress(value);
    setPhase(value.stage);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = input.current?.files?.[0];
    if (!file) {
      setPhase("error");
      setMessage("请先选择一个 ZIP 文件。");
      return;
    }
    const validation = validateUploadFile(file);
    if (validation) {
      setPhase("error");
      setMessage(validation);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setMessage(null);
    setProgress(null);
    setPhase("hashing");
    try {
      await uploadPublisherFile(file, releaseId, abort.signal, updateProgress);
      setHasResume(false);
      setPhase("complete");
      setMessage("文件字节已直传隔离桶。当前状态仍不可信；扫描验证通过后才能提交审核。");
      if (input.current) input.current.value = "";
      router.refresh();
    } catch (error) {
      setHasResume(Boolean(readUploadResume(releaseId)));
      setPhase("error");
      setMessage(error instanceof Error ? error.message : "上传未完成，请重新选择文件。");
    } finally {
      controller.current = null;
    }
  }

  function forgetResume() {
    clearUploadResume(releaseId);
    if (input.current) input.current.value = "";
    setHasResume(false);
    setProgress(null);
    setPhase("idle");
    setMessage("已放弃本地恢复记录；隔离桶中的未完成分片将由过期清理回收。");
  }

  const percent = progress ? Math.round(progress.completed / progress.total * 100) : 0;
  return <section className="publisher-upload-panel" aria-labelledby="upload-heading">
    <div><p className="eyebrow">DIRECT MULTIPART</p><h3 id="upload-heading">上传 ZIP Artifact</h3></div>
    <p>浏览器以有界分片计算摘要并直接 PUT 到私有隔离桶；Rust API 只处理元数据、短时签名和完成清单，不代理文件字节。</p>
    <form onSubmit={submit}>
      <label>Artifact ZIP
        <input ref={input} type="file" name="artifact" required disabled={busy}
          accept=".zip,application/zip,application/x-zip-compressed,application/octet-stream" />
        <span>最大 2 GiB；安全 ASCII 文件名；3 个分片并发；失败分片最多重试 3 次。</span>
      </label>
      <div className="upload-actions">
        <button className="primary-button" type="submit" disabled={busy}>
          {busy ? "上传处理中…" : hasResume ? "校验并恢复直传" : "开始安全直传"}
        </button>
        {busy ? <button className="secondary-button" type="button"
          onClick={() => controller.current?.abort()}>取消上传</button> : null}
        {!busy && hasResume ? <button className="secondary-button" type="button"
          onClick={forgetResume}>放弃待恢复上传</button> : null}
      </div>
    </form>
    <div className="upload-status" role="status" aria-live="polite" data-state={phase}>
      <div><strong>{phaseLabels[phase]}</strong>{progress ? <span>{percent}%</span> : null}</div>
      {progress ? <progress max={progress.total} value={progress.completed}>{percent}%</progress> : null}
      {message ? <p>{message}</p> : null}
    </div>
  </section>;
}
