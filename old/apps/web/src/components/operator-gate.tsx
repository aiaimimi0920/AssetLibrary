import Link from "next/link";
import type { AccountSessionResult } from "@/lib/account-session";

export type OperatorGateFailure = Exclude<AccountSessionResult, { ok: true }>["failure"]
  | "api_unavailable" | "forbidden" | "invalid_request" | "not_found";

const copy: Record<OperatorGateFailure, { title: string; body: string }> = {
  unauthenticated: { title: "需要外部账号会话", body: "请先由独立 Account Service 建立会话；AssetLibrary 不保存账号凭据。" },
  not_configured: { title: "账号适配器尚未配置", body: "当前部署不能验证外部会话，因此审核工作区保持关闭。" },
  unavailable: { title: "账号服务暂时不可用", body: "会话无法确认。为避免身份串用，审核数据不会显示。" },
  invalid_response: { title: "账号会话响应无效", body: "Account Service 响应不符合合同，AssetLibrary 已拒绝继续。" },
  api_unavailable: { title: "审核数据暂时不可用", body: "控制平面依赖失败或返回无效响应；这里不会把故障伪装成空队列。" },
  forbidden: { title: "没有 Operator 工作区权限", body: "当前外部账号没有该页面所需的有效 Store Role，或角色已被撤销。" },
  invalid_request: { title: "审核请求无效", body: "分页游标或资源标识不符合合同。请返回队列重新进入。" },
  not_found: { title: "目标资源不存在", body: "目标 Submission 或 Moderation Case 不存在、元数据不完整，或已无法读取。" },
};

export function OperatorGate({ failure, loginUrl }: { failure: OperatorGateFailure; loginUrl?: string | null }) {
  const message = copy[failure];
  return (
    <section className={`console-gate ${failure === "invalid_response" ? "console-gate-error" : ""}`}>
      <p className="eyebrow">OPERATOR ACCESS GATE</p>
      <h1>{message.title}</h1>
      <p>{message.body}</p>
      <div className="console-gate-actions">
        <Link className={loginUrl ? "secondary-link" : "primary-link"} href="/">返回公开商店</Link>
        {loginUrl ? <a className="primary-link" href={loginUrl}>前往账号服务</a> : null}
      </div>
    </section>
  );
}
