import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { sha256, trivyWindowsSha256 } from "./scanner-release-policy.mjs";

export async function verifyTrivy(executable) {
  assert.equal(process.platform, "win32", "TRIVY_PLATFORM_NOT_PINNED");
  assert.equal(sha256(await readFile(executable)), trivyWindowsSha256, "TRIVY_BINARY_MISMATCH");
}

/** 不从当前目录或环境继承忽略/严重性过滤；所有报告均在新候选目录中生成。 */
export async function scanReleaseImage(executable, cache, output, image) {
  await verifyTrivy(executable);
  const directory = path.join(output, "scanner");
  const config = path.join(directory, "trivy-empty.yaml");
  const ignore = path.join(directory, "trivy-empty.ignore");
  const report = path.join(directory, "vulnerabilities.json");
  await writeFile(config, "{}\n", { flag: "wx" });
  await writeFile(ignore, "", { flag: "wx" });
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("TRIVY_")),
  );
  const args = [
    "proxy",
    path.resolve(executable),
    "image",
    "--cache-dir",
    path.resolve(cache),
    "--config",
    config,
    "--ignorefile",
    ignore,
    "--scanners",
    "vuln",
    "--severity",
    "UNKNOWN,LOW,MEDIUM,HIGH,CRITICAL",
    "--show-suppressed",
    "--list-all-pkgs",
    "--format",
    "json",
    "--output",
    report,
    "--timeout",
    "5m",
    image,
  ];
  try {
    const { stdout, stderr } = await promisify(execFile)("rtk", args, {
      cwd: output,
      env,
      timeout: 360000,
      maxBuffer: 1048576,
    });
    await writeFile(path.join(directory, "vulnerability-scan.log"), stdout + stderr);
  } catch (error) {
    await writeFile(
      path.join(directory, "vulnerability-scan.log"),
      `${error.stdout ?? ""}${error.stderr ?? ""}`,
    );
    throw new Error("TRIVY_EXECUTION_FAILED");
  }
  await copyFile(
    path.join(cache, "db/metadata.json"),
    path.join(directory, "vulnerability-database.json"),
  );
  return { command: args.slice(2), executableSha256: trivyWindowsSha256, noIgnoreUnfixed: true };
}
