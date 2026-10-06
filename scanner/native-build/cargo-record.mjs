#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";

// CMake 的 cargo 入口：不改上游源码，强制锁文件/离线并记录实际编译产物消息。
const args = process.argv.slice(2);
if (args[0] !== "build") {
  const result = spawnSync("/usr/bin/cargo", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
assert(!args.some((arg) => arg.startsWith("--message-format")), "CARGO_FORMAT_CONFLICT");
args.push("--frozen", "--message-format=json-render-diagnostics");
writeFileSync(
  "/evidence/cargo-command.json",
  `${JSON.stringify({ args, cwd: process.cwd(), rustflags: process.env.RUSTFLAGS ?? "", offline: process.env.CARGO_NET_OFFLINE }, null, 2)}\n`,
  { flag: "wx" },
);
const fd = openSync("/evidence/cargo-artifacts.jsonl", "wx");
try {
  const result = spawnSync("/usr/bin/cargo", args, {
    stdio: ["ignore", fd, "inherit"],
    timeout: 1500000,
  });
  if (result.error || result.status !== 0) throw new Error("OFFLINE_CARGO_BUILD_FAILED");
} finally {
  closeSync(fd);
}
