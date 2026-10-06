import { writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "./build.mjs";
import { createTrialRuntime } from "./trial/runtime.mjs";
import { serveTrial } from "./trial/server.mjs";

// 没有监听地址、真实账号、云部署或恢复既有数据参数；每次创建独占本地状态。
if (process.argv.length > 2) throw new Error("LOCAL_TRIAL_ACCEPTS_NO_ARGUMENTS");
const directory = await build();
const runtime = await createTrialRuntime(directory);
let server;
try {
  server = await serveTrial(runtime, { onStop: close });
} catch (error) {
  await runtime.dispose();
  throw error;
}
let closing = false;
const timer = setInterval(() => {
  runtime.tick().catch(() => console.error("TRIAL_MAINTENANCE_FAILED"));
}, 2000);
const receipt = {
  mode: "local-trial-only",
  origin: server.origin,
  pid: process.pid,
  bundle: directory,
  productionBundleSha256: runtime.sourceHash,
  state: runtime.state,
  syntheticIdentity: true,
  syntheticAV: true,
  hypotheticalDeploymentAdmission: true,
  cloudDeployed: false,
};
await writeFile(
  path.join(runtime.state, "session.json"),
  `${JSON.stringify(receipt, null, 2)}\n`,
  "utf8",
);
console.log(`LOCAL_TRIAL_READY ${server.origin}`);
console.log(`LOCAL_TRIAL_STATE ${runtime.state}`);
console.log("本地全流程体验：虚构身份、合成 AV、非生产环境。Ctrl+C 停止，数据保留。");
async function close() {
  if (closing) return;
  closing = true;
  process.stdin.pause();
  clearInterval(timer);
  await server.close();
  await runtime.dispose();
  await writeFile(
    path.join(runtime.state, "closed.json"),
    `${JSON.stringify({ closed: true, at: new Date().toISOString() })}\n`,
    "utf8",
  );
}
process.once("SIGINT", close);
process.once("SIGTERM", close);
// 自动化可在所属进程的 stdin 发送换行收尾；不终止其他运行时。
process.stdin.once("data", close);
