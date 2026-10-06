import { mkdir, mkdtemp, readFile } from "node:fs/promises";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Log, LogLevel, Miniflare } from "miniflare";
import { artifactRoot } from "../source-scope.mjs";
import { trialModules } from "./bundle.mjs";

export const identities = [
  { number: "10001", principal: "trial:10001", label: "发布者" },
  { number: "10002", principal: "trial:10002", label: "独立审核者" },
  { number: "10003", principal: "trial:10003", label: "下载者" },
  { number: "10004", principal: "trial:10004", label: "未授权对照用户" },
];

export async function createTrialRuntime(directory) {
  const loaded = await trialModules(directory);
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  await mkdir(artifactRoot, { recursive: true });
  const state = await mkdtemp(path.join(artifactRoot, "assetlibrary-local-trial-"));
  const denyOutbound = { type: "fetcher", handler: () => new Response(null, { status: 503 }) };
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    log: new Log(LogLevel.ERROR),
    // 体验进程不逐 2 秒写入正常维护日志；只记录固定错误关键字，不落原始凭据或请求。
    handleStructuredLogs(entry) {
      try {
        const event = JSON.parse(entry.message);
        if (event.status === "failed" || (typeof event.status === "number" && event.status >= 500))
          console.error("TRIAL_RUNTIME_OPERATION_FAILED");
      } catch {
        /* 平台非应用事件不落入体验日志。 */
      }
    },
    telemetry: { enabled: false },
    unsafeTriggerHandlers: true,
    resourcePersistencePath: path.join(state, "storage"),
    resourceTmpPath: path.join(state, "tmp"),
    workers: [
      {
        config: {
          name: "assetlibrary-local-trial",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["enable_request_signal"],
          manifest: { mainModule: "index.js", modulesRoot: directory, modules: loaded.modules },
          env: {
            DB: { type: "d1", id: "local-trial" },
            QUARANTINE: { type: "r2", name: "local-trial" },
            SCANNER: { type: "worker", worker: "trial-scanner" },
            AUTH_PUBLIC_JWK: { type: "text", value: JSON.stringify(await exportJWK(publicKey)) },
            AUTH_ISSUER: { type: "text", value: "https://assetlibrary-trial.invalid" },
            AUTH_AUDIENCE: { type: "text", value: "assetlibrary-local-trial" },
            REVIEWER_PRINCIPALS: { type: "text", value: JSON.stringify(["trial:10002"]) },
          },
        },
        dev: { outboundService: denyOutbound, unsafeRegisterWorker: false },
      },
      {
        config: {
          name: "trial-scanner",
          compatibilityDate: "2026-10-01",
          manifest: {
            mainModule: "scanner.js",
            modulesRoot: directory,
            modules: {
              "scanner.js": {
                type: "esm",
                contents: await readFile(new URL("./scanner.worker.js", import.meta.url), "utf8"),
              },
            },
          },
        },
        dev: { outboundService: denyOutbound, unsafeRegisterWorker: false },
      },
    ],
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const name of Object.keys(loaded.manifest.artifacts)
      .filter((file) => /^db\/\d+_.*\.sql$/.test(file))
      .sort()) {
      const sql = await readFile(path.join(directory, name), "utf8");
      await db.batch(
        sql
          .split(";")
          .filter((part) => part.trim())
          .map((part) => db.prepare(part)),
      );
    }
    let running = null;
    let closed = false;
    async function tick() {
      if (closed) throw new Error("TRIAL_CLOSED");
      running ??= mf
        .dispatchFetch("http://localhost/cdn-cgi/local/scheduled")
        .then(async (response) => {
          await response.text();
          if (!response.ok) throw new Error("TRIAL_MAINTENANCE_FAILED");
        })
        .finally(() => {
          running = null;
        });
      return running;
    }
    return {
      mf,
      db,
      state,
      sourceHash: loaded.sourceHash,
      tick,
      async token(number) {
        const identity = identities.find((entry) => entry.number === number);
        if (!identity) throw new Error("INVALID_TRIAL_NUMBER");
        const now = Math.floor(Date.now() / 1000);
        return new SignJWT({ sub: identity.principal, iat: now, exp: now + 900 })
          .setProtectedHeader({ alg: "RS256" })
          .setIssuer("https://assetlibrary-trial.invalid")
          .setAudience("assetlibrary-local-trial")
          .sign(privateKey);
      },
      async dispose() {
        closed = true;
        await running?.catch(() => {});
        await mf.dispose();
      },
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}
