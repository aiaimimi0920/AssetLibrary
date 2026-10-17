import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { artZip } from "./art-package-zip.mjs";

// 真实便携 EXE：新版除首尾空格外还合并连续空格，不在安装阶段运行。
export async function applicationUpdateFixture(loom, state, version) {
  const output = path.join(state, `TextNormalize-${version}.exe`);
  execFileSync(
    path.join(process.env.WINDIR, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
    [
      "/nologo",
      "/target:exe",
      "/platform:x64",
      "/optimize+",
      `/out:${output}`,
      ...(version === "1.1.0" ? ["/define:VERSION2"] : []),
      path.join(loom, "apps/daemon/src/tests/fixtures/TextNormalize.cs"),
    ],
    { windowsHide: true, timeout: 30000 },
  );
  const files = [
    {
      path: "application.json",
      bytes: Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          version,
          platform: "windows-x86_64",
          entry: "TextNormalize.exe",
        }),
      ),
    },
    { path: "TextNormalize.exe", bytes: await readFile(output) },
  ];
  const manifest = {
    schema: "neuro-software-package-v1",
    kind: "application",
    files: files.map(({ path: filePath, bytes }) => ({
      path: filePath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
    })),
  };
  return artZip([
    { path: "manifest.json", bytes: Buffer.from(JSON.stringify(manifest)) },
    ...files,
  ]);
}
