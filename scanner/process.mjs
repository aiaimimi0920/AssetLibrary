import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

export const engineVersion = "1.5.4";
export async function verifyEngine() {
  const { stdout } = await promisify(execFile)("clamscan", ["--version"], {
    timeout: 5000,
    maxBuffer: 4096,
  });
  if (!/^ClamAV 1\.5\.4\//.test(stdout)) throw new Error("SCANNER_ENGINE_MISMATCH");
}
/** 无 shell、固定参数、单次进程；超时/取消/输出越界必杀并等待 close 后清理文件。 */
export function scanFile(filename, database, signal) {
  const args = [
    "--stdout",
    "--disable-cache",
    "--official-db-only=yes",
    "--bytecode-unsigned=no",
    "--scan-archive=yes",
    "--scan-image=yes",
    "--alert-encrypted=yes",
    "--alert-exceeds-max=yes",
    "--alert-broken-media=yes",
    "--max-filesize=8M",
    "--max-scansize=64M",
    "--max-files=64",
    "--max-recursion=4",
    "--bytecode-timeout=1000",
    "--max-scantime=0",
    ...database.files.map((file) => `--database=/var/lib/clamav/${file.name}`),
    filename,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn("clamscan", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH },
    });
    let output = "";
    let size = 0;
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(stop, 45000);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (data) => {
        size += data.length;
        if (size > 65536) stop();
        else output += data.toString("utf8");
      });
    child.once("error", () => {
      stopped = true;
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", stop);
      if (
        stopped ||
        ![0, 1].includes(code) ||
        /ERROR|WARNING|Warning|Total errors:\s*[1-9]/.test(output) ||
        !/Scanned files:\s*1\b/.test(output) ||
        (code === 0 && !/Infected files:\s*0\b/.test(output))
      )
        reject(new Error("SCANNER_INCOMPLETE"));
      else resolve(code === 0 ? "clean" : "infected");
    });
  });
}
