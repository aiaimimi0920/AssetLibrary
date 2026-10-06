let credential = "";
let generation = 0;
const controllers = new Set();
const keys = new Map();

/** 身份不持久化；切换身份主动中止旧请求，旧响应不得进入新主体的视图。 */
export function setCredential(value) {
  stopRequests();
  generation += 1;
  credential = value.trim();
  keys.clear();
}
export function connected() {
  return credential.length > 0;
}
export function stopRequests() {
  for (const controller of controllers) controller.abort();
}

export function operationKey(scope, body) {
  const fingerprint = JSON.stringify([scope, body]);
  if (!keys.has(fingerprint)) {
    if (keys.size >= 32) throw new Error("PENDING_OPERATION_LIMIT_REFRESH_REQUIRED");
    keys.set(fingerprint, { key: crypto.randomUUID() });
  }
  return { fingerprint, key: keys.get(fingerprint).key };
}
// 旧响应不能绑定或释放相同摘要的新意图；服务器 ID 是终态确认的必要关联。
export function bindOperation(operation, subject) {
  const current = keys.get(operation.fingerprint);
  if (
    typeof subject === "string" &&
    subject &&
    current?.key === operation.key &&
    (current.subject === undefined || current.subject === subject)
  )
    current.subject = subject;
}
export function completeOperation(operation) {
  if (keys.get(operation.fingerprint)?.key === operation.key) keys.delete(operation.fingerprint);
}
export function resolveOperation(scope, body, subject) {
  const fingerprint = JSON.stringify([scope, body]);
  if (typeof subject === "string" && subject && keys.get(fingerprint)?.subject === subject)
    keys.delete(fingerprint);
}

/** consume 必须在控制器生命周期内读完响应，下载不能在返回后失去取消/身份保护。 */
export async function withResponse(
  path,
  { method = "GET", body, signal, key, raw = false, publicRead = false, ticket, range, ifRange },
  consume,
) {
  if (!credential && !publicRead) throw new Error("IDENTITY_REQUIRED");
  if (
    !path.startsWith("/v1/") ||
    !new URL(path, "http://assetlibrary.invalid").pathname.startsWith("/v1/")
  )
    throw new Error("INVALID_API_PATH");
  if (publicRead && (method !== "GET" || !/^\/v1\/catalog(?:\?|\/[0-9a-f-]{36}$|$)/.test(path)))
    throw new Error("INVALID_PUBLIC_API_PATH");
  // ?????????? Range???????????????? header?
  if (range !== undefined || ifRange !== undefined) {
    const match = typeof range === "string" && /^bytes=([0-9]+)-([0-9]+)$/.exec(range);
    const start = match ? Number(match[1]) : -1;
    const end = match ? Number(match[2]) : -1;
    if (
      publicRead ||
      method !== "GET" ||
      body !== undefined ||
      !/^\/v1\/publications\/[0-9a-f-]{36}\/content$/.test(path) ||
      !/^[0-9a-f]{64}$/.test(ticket ?? "") ||
      !match ||
      range.length > 128 ||
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end < start ||
      end >= 8 * 1024 * 1024 ||
      end - start + 1 > 256 * 1024 ||
      (ifRange !== undefined &&
        (typeof ifRange !== "string" || !/^"[\x21\x23-\x7e]{1,126}"$/.test(ifRange)))
    )
      throw new Error("INVALID_DOWNLOAD_RANGE");
  }
  const current = generation;
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  controllers.add(controller);
  const timer = setTimeout(abort, raw || ticket ? 120000 : 30000);
  let response;
  try {
    response = await fetch(path, {
      method,
      signal: controller.signal,
      redirect: "error",
      credentials: "omit",
      cache: "no-store",
      headers: {
        ...(publicRead ? {} : { Authorization: `Bearer ${credential}` }),
        ...(ticket ? { "X-Download-Ticket": ticket } : {}),
        ...(range !== undefined ? { Range: range } : {}),
        ...(ifRange !== undefined ? { "If-Range": ifRange } : {}),
        ...(body === undefined
          ? {}
          : { "Content-Type": raw ? "application/octet-stream" : "application/json" }),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(body === undefined ? {} : { body: raw ? body : JSON.stringify(body) }),
    });
    if (current !== generation || controller.signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    if (!response.ok) {
      const result = await response.json();
      if (current !== generation || controller.signal.aborted)
        throw new DOMException("Aborted", "AbortError");
      throw Object.assign(new Error(`${response.status} ${result.error ?? "REQUEST_FAILED"}`), {
        status: response.status,
        code: result.error,
      });
    }
    const result = await consume(response, controller.signal);
    if (current !== generation || controller.signal.aborted)
      throw new DOMException("Aborted", "AbortError");
    return result;
  } finally {
    if (response?.body && !response.bodyUsed && !response.body.locked)
      await response.body.cancel().catch(() => {});
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controllers.delete(controller);
  }
}

export function api(path, options = {}) {
  return withResponse(path, options, (response) => response.json());
}
