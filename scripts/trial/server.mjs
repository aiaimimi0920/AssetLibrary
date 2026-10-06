import http from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { packageBytes } from "../../tests/art-package-fixture.mjs";
import { trialClient, trialPage } from "./presentation.mjs";
import { identities } from "./runtime.mjs";

const limit = 16 * 1024 * 1024;
const forwarded = [
  "authorization",
  "content-type",
  "content-length",
  "idempotency-key",
  "x-download-ticket",
  "range",
  "if-range",
  "if-none-match",
];
const assets = new Set([
  "/",
  "/style.css",
  ...[
    "app",
    "api",
    "render",
    "upload",
    "distribution",
    "distribution-render",
    "download",
    "resource",
  ].map((name) => `/${name}.client.js`),
]);

function limitedBody(request, maximum) {
  let size = 0;
  return Readable.toWeb(request).pipeThrough(
    new TransformStream({
      transform(chunk, controller) {
        size += chunk.length;
        if (size > maximum) throw new Error("TRIAL_BODY_TOO_LARGE");
        controller.enqueue(chunk);
      },
    }),
  );
}

/** 仅监听回环；Host/Origin/Fetch Metadata 限制阻止外部网页借用本地无注册入口。 */
export async function serveTrial(runtime, { port = 0, onStop } = {}) {
  const client = await trialClient();
  const sample = packageBytes();
  const active = new Set();
  let origin;
  const server = http.createServer(async (request, reply) => {
    const send = (status, value, type = "application/json") => {
      reply.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "x-assetlibrary-mode": "local-trial-only",
      });
      reply.end(type === "application/json" ? JSON.stringify(value) : value);
    };
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin && request.headers.origin !== origin) ||
      ["cross-site", "same-site"].includes(request.headers["sec-fetch-site"])
    )
      return send(403, { error: "TRIAL_ORIGIN_DENIED" });
    if (!request.url.startsWith("/") || request.url.startsWith("//"))
      return send(400, { error: "INVALID_PATH" });
    if (active.size >= 8) return send(503, { error: "TRIAL_BUSY" });
    if (Number(request.headers["content-length"] ?? 0) > limit)
      return send(413, { error: "TRIAL_BODY_TOO_LARGE" });
    const controller = new AbortController();
    active.add(controller);
    const abort = () => {
      if (!reply.writableEnded) controller.abort();
    };
    request.once("aborted", abort);
    reply.once("close", abort);
    const timer = setTimeout(() => controller.abort(), 130000);
    try {
      const url = new URL(request.url, origin);
      if (url.pathname === "/__trial/client.js" && request.method === "GET")
        return send(200, client, "text/javascript; charset=utf-8");
      if (url.pathname === "/__trial/sample.zip" && request.method === "GET") {
        reply.setHeader("content-disposition", 'attachment; filename="two-png.zip"');
        return send(200, sample, "application/zip");
      }
      if (["/__trial/login", "/__trial/tick", "/__trial/stop"].includes(url.pathname)) {
        if (
          request.method !== "POST" ||
          request.headers.origin !== origin ||
          request.headers["x-assetlibrary-trial"] !== "1" ||
          request.headers["content-type"] !== "application/json"
        )
          return send(403, { error: "TRIAL_REQUEST_DENIED" });
        let body;
        try {
          body = await new Response(limitedBody(request, 4096)).json();
        } catch {
          return send(400, { error: "INVALID_TRIAL_BODY" });
        }
        if (!body || typeof body !== "object" || Array.isArray(body))
          return send(400, { error: "INVALID_TRIAL_BODY" });
        if (url.pathname !== "/__trial/login") {
          if (!body || Object.keys(body).length !== 0)
            return send(400, { error: "INVALID_TRIAL_BODY" });
          if (url.pathname === "/__trial/stop") {
            if (!onStop) return send(404, { error: "NOT_FOUND" });
            send(200, { stopping: true, dataPreserved: true });
            setTimeout(() => {
              void onStop();
            }, 0);
            return;
          }
          await runtime.tick();
          return send(200, { completed: true, simulated: true });
        }
        const identity = identities.find((entry) => entry.number === body?.number);
        if (!identity || Object.keys(body).length !== 1)
          return send(400, { error: "INVALID_TRIAL_NUMBER" });
        return send(200, {
          principal: identity.principal,
          token: await runtime.token(identity.number),
        });
      }
      if (
        !assets.has(url.pathname) &&
        !url.pathname.startsWith("/v1/") &&
        !["/healthz", "/readyz"].includes(url.pathname)
      )
        return send(404, { error: "NOT_FOUND" });
      const result = await runtime.mf.dispatchFetch(
        `http://localhost${url.pathname}${url.search}`,
        {
          method: request.method,
          headers: Object.fromEntries(
            forwarded
              .filter((key) => request.headers[key] !== undefined)
              .map((key) => [key, request.headers[key]]),
          ),
          signal: controller.signal,
          ...(!["GET", "HEAD"].includes(request.method)
            ? { body: limitedBody(request, limit), duplex: "half" }
            : {}),
        },
      );
      const headers = Object.fromEntries(result.headers);
      headers["x-assetlibrary-mode"] = "local-trial-only";
      if (url.pathname === "/" && request.method === "GET") {
        const page = await trialPage(await result.text());
        delete headers["content-length"];
        reply.writeHead(result.status, headers);
        reply.end(page);
      } else {
        reply.writeHead(result.status, headers);
        if (result.body)
          await pipeline(Readable.fromWeb(result.body), reply, { signal: controller.signal });
        else reply.end();
      }
    } catch {
      if (!reply.headersSent) send(503, { error: "TRIAL_REQUEST_FAILED" });
      else reply.destroy();
    } finally {
      clearTimeout(timer);
      active.delete(controller);
      request.removeListener("aborted", abort);
      reply.removeListener("close", abort);
    }
  });
  server.requestTimeout = 130000;
  server.headersTimeout = 10000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    async close() {
      const closed = new Promise((resolve) => server.close(resolve));
      for (const controller of active) controller.abort();
      server.closeAllConnections();
      await closed;
    },
  };
}
