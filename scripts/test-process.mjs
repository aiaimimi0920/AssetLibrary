import { spawnSync } from "node:child_process";
import { closeSync, openSync } from "node:fs";

// 测试输出直接落盘，避免 spawnSync 默认管道预算截断完整回归。
export function runTestProcess(args, { logPath, ...options }) {
  const fd = openSync(logPath, "wx");
  try {
    const result = spawnSync(process.execPath, args, {
      ...options,
      stdio: ["ignore", fd, fd],
    });
    return {
      error: result.error,
      signal: result.signal,
      exitCode: result.error ? 1 : (result.status ?? 1),
    };
  } finally {
    closeSync(fd);
  }
}
