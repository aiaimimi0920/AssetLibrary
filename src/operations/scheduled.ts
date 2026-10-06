import { expireTickets } from "../distribution/tickets";
import { inspectDue } from "../inspections/runner";
import { reconcileDue } from "../uploads/reconcile";
import type { UploadEnv } from "../uploads/records";
import { observeSchedule, observeStage } from "./events";

/** 独立维护阶段顺序执行一次；失败不阻止其余阶段，不新增重试或脱离 owner 的任务。 */
export async function scheduledWork(env: UploadEnv) {
  const runId = crypto.randomUUID();
  const start = performance.now();
  let failedStages = 0;
  let firstError: string | undefined;
  const stages = [
    { name: "uploads", error: "UPLOAD_RECONCILE_INCOMPLETE", run: () => reconcileDue(env) },
    { name: "inspections", error: "INSPECTION_SCHEDULER_INCOMPLETE", run: () => inspectDue(env) },
    {
      name: "tickets",
      error: "TICKET_CLEANUP_INCOMPLETE",
      run: async () => {
        const removed = await expireTickets(env.DB);
        return { processed: removed, completed: removed, failed: 0 };
      },
    },
  ] as const;
  for (const stage of stages) {
    const stageStart = performance.now();
    let counts: Awaited<ReturnType<typeof stage.run>> | undefined;
    let failed = false;
    try {
      counts = await stage.run();
      failed = counts.failed > 0;
    } catch {
      // 可能已完成部分事实；没有返回聚合结果时不伪造 processed=0 或记录异常内容。
      failed = true;
    }
    if (failed) {
      failedStages++;
      firstError ??= stage.error;
    }
    observeStage(runId, stage.name, failed, stageStart, counts);
  }
  observeSchedule(runId, failedStages, start);
  if (firstError) throw new Error(firstError);
}
