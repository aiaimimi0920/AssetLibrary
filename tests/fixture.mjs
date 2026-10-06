import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Log, LogLevel, Miniflare } from "miniflare";
import { textModules } from "./worker-fixture.mjs";

export async function fixture({
  schema = true,
  identity = true,
  streamFaults = false,
  reviewers,
  runtimeLog,
} = {}) {
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const jwk = await exportJWK(publicKey);
  const bundle = process.env.ASSETLIBRARY_BUNDLE;
  if (!bundle) throw new Error("ASSETLIBRARY_BUNDLE_REQUIRED");
  // 隔离库不放进可部署产物目录，避免本地数据被误打包。
  const persist = await mkdtemp(
    path.join(path.dirname(path.dirname(bundle)), "assetlibrary-p2-storage-"),
  );
  const runtimeOptions = {
    cf: false,
    log: new Log(LogLevel.ERROR),
    ...(runtimeLog ? { handleStructuredLogs: (entry) => runtimeLog.log(entry.message) } : {}),
    telemetry: { enabled: false },
    unsafeTriggerHandlers: true,
    // Miniflare 5 的 D1/R2 使用 resourcePersistencePath；isolated 字段不能单独代替它。
    resourcePersistencePath: persist,
    resourceTmpPath: path.join(persist, "tmp"),
    workers: [
      {
        config: {
          name: "assetlibrary-test",
          compatibilityDate: "2026-10-01",
          compatibilityFlags: ["enable_request_signal"],
          manifest: {
            mainModule: streamFaults ? "upload-stream-worker.mjs" : "index.js",
            modulesRoot: path.dirname(bundle),
            modules: {
              "index.js": { type: "esm", contents: await readFile(bundle, "utf8") },
              ...(await textModules(bundle)),
              ...(streamFaults
                ? {
                    "upload-stream-worker.mjs": {
                      type: "esm",
                      contents: await readFile(
                        new URL("./upload-stream-worker.mjs", import.meta.url),
                        "utf8",
                      ),
                    },
                  }
                : {}),
            },
          },
          env: {
            DB: { type: "d1", id: "assetlibrary-test" },
            QUARANTINE: { type: "r2", name: "assetlibrary-test-quarantine" },
            ...(reviewers === undefined
              ? {}
              : { REVIEWER_PRINCIPALS: { type: "text", value: reviewers } }),
            ...(identity
              ? {
                  AUTH_PUBLIC_JWK: { type: "text", value: JSON.stringify(jwk) },
                  AUTH_ISSUER: { type: "text", value: "https://identity.test" },
                  AUTH_AUDIENCE: { type: "text", value: "assetlibrary-test" },
                }
              : {}),
          },
        },
      },
    ],
  };
  let mf = new Miniflare(runtimeOptions);
  try {
    let db = await mf.getD1Database("DB");
    if (schema) {
      const migrations = (await readdir(new URL("../db/", import.meta.url)))
        .filter((name) => name.endsWith(".sql"))
        .sort();
      const sql = (
        await Promise.all(
          migrations.map((name) => readFile(new URL(`../db/${name}`, import.meta.url), "utf8")),
        )
      ).join("\n");
      await db.batch(
        sql
          .split(";")
          .filter((part) => part.trim())
          .map((part) => db.prepare(part)),
      );
    }
    async function token(principal = "user:alice", options = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({
        sub: principal,
        iat: now,
        exp: now + 300,
        iss: "https://identity.test",
        aud: "assetlibrary-test",
        ...options,
      })
        .setProtectedHeader({ alg: "RS256" })
        .sign(privateKey);
    }
    async function request(method, pathname, body, options = {}) {
      const bearer = options.token === undefined ? await token(options.principal) : options.token;
      const headers = {
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        "idempotency-key": options.key ?? randomUUID(),
        ...options.headers,
      };
      const response = await mf.dispatchFetch(`http://localhost${pathname}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, body: await response.json(), headers: response.headers };
    }
    let bucket = await mf.getR2Bucket("QUARANTINE");
    const env = {
      DB: db,
      QUARANTINE: bucket,
      AUTH_PUBLIC_JWK: JSON.stringify(jwk),
      AUTH_ISSUER: "https://identity.test",
      AUTH_AUDIENCE: "assetlibrary-test",
      ...(reviewers === undefined ? {} : { REVIEWER_PRINCIPALS: reviewers }),
    };
    async function configureIdentity(config) {
      const worker = runtimeOptions.workers[0].config;
      const bindings = { ...worker.env };
      for (const field of ["AUTH_PUBLIC_JWK", "AUTH_PUBLIC_JWKS", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
        delete bindings[field];
        if (config[field] !== undefined) bindings[field] = { type: "text", value: config[field] };
      }
      // 只替换身份 binding；同一 persistence、D1/R2 名称和模块保持不变，不重建 Schema。
      const next = {
        ...runtimeOptions,
        workers: [{ config: { ...worker, env: bindings } }],
      };
      await mf.setOptions(next);
      runtimeOptions.workers = next.workers;
      // Miniflare 重配置使旧 stub 失效；重新取引用，但不改变任何持久化内容。
      db = await mf.getD1Database("DB");
      bucket = await mf.getR2Bucket("QUARANTINE");
      env.DB = db;
      env.QUARANTINE = bucket;
      for (const field of ["AUTH_PUBLIC_JWK", "AUTH_PUBLIC_JWKS", "AUTH_ISSUER", "AUTH_AUDIENCE"]) {
        delete env[field];
        if (config[field] !== undefined) env[field] = config[field];
      }
    }
    let restarting = false;
    async function restart(onStopped) {
      if (restarting) throw new Error("FIXTURE_RESTART_IN_PROGRESS");
      restarting = true;
      try {
        // 完整关闭旧实例后才开新实例；不执行迁移、不重置持久业务或租约。
        await mf.dispose();
        await onStopped?.();
        mf = new Miniflare(runtimeOptions);
        db = await mf.getD1Database("DB");
        bucket = await mf.getR2Bucket("QUARANTINE");
        env.DB = db;
        env.QUARANTINE = bucket;
      } finally {
        restarting = false;
      }
    }
    return {
      get mf() {
        return mf;
      },
      persist,
      restart,
      get db() {
        return db;
      },
      get bucket() {
        return bucket;
      },
      env,
      token,
      request,
      configureIdentity,
      dispose: () => mf.dispose(),
    };
  } catch (error) {
    await mf.dispose();
    throw error;
  }
}

export async function createResource(f, options = {}) {
  const response = await f.request(
    "POST",
    "/v1/resources",
    { kind: "art", title: "无害测试资源" },
    options,
  );
  if (response.status !== 201) throw new Error(`CREATE_FAILED: ${JSON.stringify(response)}`);
  return response.body;
}
