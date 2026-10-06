type Stage = "uploads" | "inspections" | "tickets";
interface Counts {
  processed?: number;
  completed?: number;
  failed?: number;
}

function write(event: Record<string, unknown>) {
  // 可观测性失败不能改变已提交业务或流式响应；不记录异常对象或任意调用方字段。
  try {
    console.log(JSON.stringify({ service: "assetlibrary", format: 1, ...event }));
  } catch {}
}

function elapsed(start: number) {
  return Math.max(0, Math.round(performance.now() - start));
}

function route(request: Request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/healthz") return "liveness";
  if (pathname === "/readyz") return "readiness";
  if (/^\/v1\/catalog(?:\/|$)/.test(pathname)) return "catalog";
  if (/^\/v1\/me(?:\/|$)/.test(pathname)) return "library";
  for (const name of ["resources", "uploads", "versions", "publications"])
    if (pathname === `/v1/${name}` || pathname.startsWith(`/v1/${name}/`)) return name;
  if (pathname === "/" || /^\/[a-z-]+\.(?:css|client\.js)$/.test(pathname)) return "web";
  return "unknown";
}

export function observeResponse(request: Request, response: Response, id: string, start: number) {
  const headers = new Headers(response.headers);
  headers.set("X-Request-ID", id);
  const result = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
  write({
    event: "http.response_ready",
    requestId: id,
    route: route(request),
    method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(request.method)
      ? request.method
      : "OTHER",
    status: result.status,
    durationMs: elapsed(start),
  });
  return result;
}

export function observeStage(
  runId: string,
  stage: Stage,
  failed: boolean,
  start: number,
  counts: Counts = {},
) {
  const bounded: Record<string, number> = {};
  for (const field of ["processed", "completed", "failed"] as const) {
    const value = counts[field];
    if (value !== undefined && Number.isSafeInteger(value) && value >= 0 && value <= 100)
      bounded[field === "failed" ? "dispatchErrors" : field] = value;
  }
  write({
    event: "scheduled.stage",
    runId,
    stage,
    scope: "bounded_batch",
    status: failed ? "incomplete" : "completed",
    durationMs: elapsed(start),
    counts: bounded,
  });
}

export function observeSchedule(runId: string, failedStages: number, start: number) {
  write({
    event: "scheduled.complete",
    runId,
    scope: "bounded_batch",
    status: failedStages ? "incomplete" : "completed",
    failedStages,
    durationMs: elapsed(start),
  });
}
