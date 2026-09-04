import Link from "next/link";
import type { AccountSessionResult } from "@/lib/account-session";

export type PublisherGateFailure = Exclude<AccountSessionResult, { ok: true }>["failure"] | "api_unavailable" | "forbidden";

const gateCopy: Record<PublisherGateFailure, { title: string; body: string }> = {
  unauthenticated: {
    title: "需要外部账号会话",
    body: "请先由独立的 Neuro Account Service 建立会话。AssetLibrary 不保存密码或登录状态。",
  },
  not_configured: {
    title: "账号适配器尚未配置",
    body: "当前部署没有配置 Account Service Session 端点，因此不会用虚构身份显示发布数据。",
  },
  unavailable: {
    title: "账号服务暂时不可用",
    body: "会话无法确认。为避免身份串用，Publisher 数据保持关闭，请稍后重试。",
  },
  invalid_response: {
    title: "账号会话响应无效",
    body: "Account Service 返回了不符合版本合同的数据，AssetLibrary 已拒绝继续。",
  },
  api_unavailable: {
    title: "Publisher 数据暂时不可用",
    body: "控制平面依赖失败或响应不符合合同；这里不会把故障显示成空工作区。",
  },
  forbidden: {
    title: "没有访问该工作区的权限",
    body: "当前外部账号不是目标 Publisher 的有效成员，或成员资格已被撤销。",
  },
};

export function PublisherGate({ failure, loginUrl }: { failure: PublisherGateFailure; loginUrl?: string | null }) {
  const copy = gateCopy[failure];
  return (
    <section className={`console-gate ${failure === "invalid_response" ? "console-gate-error" : ""}`}>
      <p className="eyebrow">IDENTITY GATE</p>
      <h1>{copy.title}</h1>
      <p>{copy.body}</p>
      <div className="console-gate-actions">
        <Link className={loginUrl ? "secondary-link" : "primary-link"} href="/">返回公开商店</Link>
        {loginUrl ? <a className="primary-link" href={loginUrl}>前往账号服务</a> : null}
      </div>
    </section>
  );
}
