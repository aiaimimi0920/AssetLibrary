import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";

// 仅由所属无网络容器执行；stdin 样本不落盘，身份来自实际加载的安装结果。
const binaries = {};
const linkedLibraries = execFileSync("ldd", ["/usr/bin/clamscan"], {
  encoding: "utf8",
  timeout: 10000,
});
const libraries = {};
for (const match of linkedLibraries.matchAll(/(?:=>\s*)?(\/(?:usr\/lib|lib)\/[^\s()]+)/g)) {
  const resolved = await realpath(match[1]);
  libraries[resolved] = createHash("sha256")
    .update(await readFile(resolved))
    .digest("hex");
}
for (const file of [
  "/usr/bin/clamscan",
  "/usr/lib/libclamav.so.12",
  "/usr/lib/libfreshclam.so.4",
  "/usr/lib/libclamunrar.so",
  "/usr/lib/libclamunrar_iface.so",
]) {
  const resolved = await realpath(file);
  binaries[file] = {
    path: resolved,
    sha256: createHash("sha256")
      .update(await readFile(resolved))
      .digest("hex"),
  };
}
const eicar = Buffer.from(
  ["X5O!P%@AP[4", "\\PZX54(P^)7CC)7}$", "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"].join(""),
);
function scan(input) {
  const started = Date.now();
  const result = spawnSync("clamscan", ["--no-summary", "-"], {
    input,
    encoding: "utf8",
    timeout: 60000,
    maxBuffer: 8192,
  });
  return {
    status: result.status,
    signal: result.signal,
    errorCode: result.error?.code ?? null,
    elapsedMs: Date.now() - started,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
console.log(
  JSON.stringify({
    binaries,
    linkedLibraries,
    libraries,
    packages: execFileSync("apk", ["--no-network", "info", "-v"], {
      encoding: "utf8",
      timeout: 10000,
    })
      .trim()
      .split("\n")
      .sort(),
    apkDatabaseSha256: createHash("sha256")
      .update(await readFile("/lib/apk/db/installed"))
      .digest("hex"),
    version: execFileSync("clamscan", ["--version"], {
      encoding: "utf8",
      timeout: 10000,
    }).trim(),
    eicar: scan(eicar),
    clean: scan("harmless"),
  }),
);
