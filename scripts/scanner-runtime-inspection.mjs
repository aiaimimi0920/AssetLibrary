import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { databaseIdentity } from "/app/database.mjs";

// 由宿主通过 stdin 在独占 Linux 验收容器执行，不加入 scanner 服务或生产镜像。
const files = {};
for (const name of ["database.mjs", "process.mjs", "server.mjs", "limits.mjs"])
  files[name] = createHash("sha256")
    .update(await readFile(`/app/${name}`))
    .digest("hex");

const scanningProcesses = [];
const pids = (await readdir("/proc")).filter((pid) => /^\d+$/.test(pid));
if (pids.length > 64) throw new Error("RUNTIME_PROCESS_PROBE_LIMIT");
for (const pid of pids) {
  try {
    if ((await readFile(`/proc/${pid}/comm`, "utf8")).trim() === "clamscan")
      scanningProcesses.push(Number(pid));
  } catch (error) {
    // 进程可能在枚举后退出；权限/其他读取失败不能当作不存在。
    if (error.code !== "ENOENT") throw error;
  }
}
console.log(
  JSON.stringify({
    temporary: await readdir("/tmp"),
    scanningProcesses,
    files,
    database: await databaseIdentity(),
  }),
);
