import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { databaseIdentity, fresh } from "./database.mjs";
import { withinZipBudget } from "./limits.mjs";
import { engineVersion, scanFile, verifyEngine } from "./process.mjs";

await verifyEngine();
const database = await databaseIdentity();
let busy = false;
const send = (response, status, value) => {
  if (!response.destroyed)
    response
      .writeHead(status, { "content-type": "application/json", "cache-control": "no-store" })
      .end(JSON.stringify(value));
};
const server = http.createServer(async (request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    send(response, fresh(database) ? 200 : 503, { ready: fresh(database), engineVersion });
    return;
  }
  const length = Number(request.headers["content-length"]);
  const expected = request.headers["x-object-sha256"];
  if (
    request.method !== "POST" ||
    request.url !== "/scan" ||
    request.headers["content-type"] !== "application/zip" ||
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > 8388608 ||
    typeof expected !== "string" ||
    !/^[0-9a-f]{64}$/.test(expected)
  ) {
    send(response, 422, { error: "SCANNER_INPUT_INVALID" });
    return;
  }
  if (busy || !fresh(database)) {
    send(response, 503, { error: "SCANNER_UNAVAILABLE" });
    return;
  }
  busy = true;
  const controller = new AbortController();
  const abort = () => {
    if (!response.writableFinished) controller.abort();
  };
  response.once("close", abort);
  request.once("aborted", abort);
  const timeout = setTimeout(() => {
    controller.abort();
    request.destroy();
  }, 60000);
  let directory;
  let fact;
  let status = 503;
  try {
    const bytes = Buffer.alloc(length);
    let size = 0;
    for await (const chunk of request) {
      if (controller.signal.aborted || size + chunk.length > length) throw new Error();
      chunk.copy(bytes, size);
      size += chunk.length;
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (size !== length || sha256 !== expected || controller.signal.aborted) throw new Error();
    if (!withinZipBudget(bytes)) {
      status = 422;
      throw new Error();
    }
    directory = await mkdtemp("/tmp/assetlibrary-scan-");
    const filename = path.join(directory, "object.zip");
    await writeFile(filename, bytes, { flag: "wx", mode: 0o600 });
    const verdict = await scanFile(filename, database, controller.signal);
    const completedAt = Date.now();
    if (!fresh(database, completedAt) || controller.signal.aborted) throw new Error();
    fact = {
      protocol: "neuro-clamav-v1",
      verdict,
      sha256,
      size,
      engineVersion,
      database: {
        sha256: database.sha256,
        dailyVersion: database.dailyVersion,
        updatedAt: database.updatedAt,
      },
      completedAt,
      expiresAt: Math.min(completedAt + 86400000, database.updatedAt + 172800000),
    };
  } catch {
    fact = undefined;
  } finally {
    clearTimeout(timeout);
    response.removeListener("close", abort);
    request.removeListener("aborted", abort);
    // 仅删除本次 mkdtemp 生成的容器内临时目录，不处理上传路径或宿主文件。
    try {
      if (directory) await rm(directory, { recursive: true, force: true });
    } catch {
      fact = undefined;
      // 清理失效后停止接纳请求，不静默积累临时文件。
      server.close();
      process.exitCode = 1;
    } finally {
      busy = false;
    }
  }
  send(
    response,
    fact ? 200 : status,
    fact ?? { error: status === 422 ? "SCANNER_ZIP_BUDGET_INVALID" : "SCANNER_INCOMPLETE" },
  );
});
server.requestTimeout = 15000;
server.headersTimeout = 10000;
server.maxConnections = 4;
server.maxRequestsPerSocket = 1;
server.listen(8080, "0.0.0.0");
console.log(JSON.stringify({ service: "art-scanner", engineVersion, database }));
