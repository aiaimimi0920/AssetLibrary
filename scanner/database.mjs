import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readdir } from "node:fs/promises";
import path from "node:path";

export const databaseRoot = "/var/lib/clamav";
export async function databaseIdentity() {
  const names = await readdir(databaseRoot);
  const files = [];
  for (const prefix of ["main", "daily", "bytecode"]) {
    const selected = names.filter((name) => name === `${prefix}.cvd` || name === `${prefix}.cld`);
    if (selected.length !== 1) throw new Error("SCANNER_DATABASE_MISSING");
    const filename = path.join(databaseRoot, selected[0]);
    const handle = await open(filename, "r");
    let fields;
    try {
      const header = Buffer.alloc(512);
      if ((await handle.read(header, 0, 512, 0)).bytesRead !== 512)
        throw new Error("SCANNER_DATABASE_INVALID");
      fields = header.toString("ascii").trim().split(":");
      // CVD/CLD 的 stime 位于第九个字段；不解析本地化的可读日期。
      if (
        fields.length !== 9 ||
        fields[0] !== "ClamAV-VDB" ||
        !/^\d+$/.test(fields[2]) ||
        !/^\d+$/.test(fields[8])
      )
        throw new Error("SCANNER_DATABASE_INVALID");
    } finally {
      await handle.close();
    }
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    files.push({
      name: selected[0],
      sha256: digest.digest("hex"),
      version: Number(fields[2]),
      updatedAt: Number(fields[8]) * 1000,
    });
  }
  const daily = files[1];
  return {
    files,
    sha256: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
    dailyVersion: daily.version,
    updatedAt: daily.updatedAt,
  };
}
export function fresh(identity, now = Date.now()) {
  return (
    Number.isSafeInteger(identity.updatedAt) &&
    identity.updatedAt <= now + 300000 &&
    identity.updatedAt > now - 172800000
  );
}
