import { HttpError, json } from "./http";
import { authenticate, type IdentityConfig } from "./identity";
import { inspectionRoutes } from "./inspections/routes";
import { observeResponse } from "./operations/events";
import { readiness } from "./operations/readiness";
import { scheduledWork } from "./operations/scheduled";
import { resourceRoutes } from "./resources/routes";
import type { UploadEnv } from "./uploads/records";
import { uploadRoutes } from "./uploads/routes";
import type { ReviewConfig } from "./versions/policy";
import { versionRoutes } from "./versions/routes";
import { webRoutes } from "./web/routes";

interface Env extends IdentityConfig, UploadEnv, ReviewConfig {}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const id = crypto.randomUUID();
    const start = performance.now();
    let response: Response;
    try {
      response = await route(request, env);
    } catch (error) {
      // 不记录 JWT、SQL 参数或驱动错误；只返回可安全重试的统一失败状态。
      response =
        error instanceof HttpError
          ? json({ error: error.code }, error.status)
          : json({ error: "SERVICE_UNAVAILABLE" }, 503);
    }
    return observeResponse(request, response, id, start);
  },
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    await scheduledWork(env);
  },
} satisfies ExportedHandler<Env>;

import { catalogRoutes, distributionRoutes } from "./distribution/routes";

async function route(request: Request, env: Env) {
  const web = webRoutes(request);
  if (web) return web;
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/healthz")
    return json({ service: "assetlibrary", status: "alive" });
  if (request.method === "GET" && path === "/readyz") return readiness(env);
  const catalog = await catalogRoutes(request, env);
  if (catalog) return catalog;
  const principal = await authenticate(request, env);
  if (request.method === "GET" && path === "/v1/me") return json({ principal });
  const distribution = await distributionRoutes(request, env, principal);
  if (distribution) return distribution;
  const versionResponse = await versionRoutes(request, env, principal);
  if (versionResponse) return versionResponse;
  const inspectionResponse = await inspectionRoutes(request, env, principal);
  if (inspectionResponse) return inspectionResponse;
  const uploadResponse = await uploadRoutes(request, env, principal);
  if (uploadResponse) return uploadResponse;
  return resourceRoutes(request, env.DB, principal);
}
