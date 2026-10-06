import { ContentRejected } from "../inspections/png";
import { parseScanFact, type ScanFact, scanCurrent } from "./facts";
import { boundedFetch } from "./transport";

export { cloudScanBlocker, type ScanFact, scanPolicy } from "./facts";
export interface ScannerEnv {
  SCANNER?: Fetcher;
}

async function responseJson(response: Response, signal: AbortSignal) {
  if (
    !response.ok ||
    response.headers.get("content-type") !== "application/json" ||
    !response.body
  ) {
    void response.body?.cancel().catch(() => {});
    throw new Error("SCANNER_UNAVAILABLE");
  }
  const reader = response.body.getReader();
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  const bytes = new Uint8Array(4096);
  let size = 0;
  try {
    if (signal.aborted) throw new Error("SCANNER_TIMEOUT");
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (size + value.byteLength > bytes.length) throw new Error("SCANNER_RESPONSE_SIZE_LIMIT");
      bytes.set(value, size);
      size += value.byteLength;
    }
    if (signal.aborted) throw new Error("SCANNER_TIMEOUT");
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, size)),
    );
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** 内部 binding 是唯一事实来源；固定请求地址，不接受客户端 URL、路径或扫描结果。 */
export async function scanArchive(
  env: ScannerEnv,
  bytes: Uint8Array,
  sha256: string,
): Promise<ScanFact> {
  if (!env.SCANNER) throw new Error("SCANNER_NOT_CONFIGURED");
  const started = Date.now();
  const controller = new AbortController();
  // R2 读取 30 秒、扫描 75 秒，为 120 秒租约留出格式检查与持久提交余量。
  const timeout = setTimeout(() => controller.abort(), 75000);
  try {
    const response = await boundedFetch(
      env.SCANNER,
      new Request("http://scanner/scan", {
        method: "POST",
        headers: {
          "content-type": "application/zip",
          "content-length": String(bytes.length),
          "x-object-sha256": sha256,
        },
        body: bytes,
        signal: controller.signal,
        // workerd 不支持 error；manual 配合 responseJson 的非 2xx 拒绝，禁止转发字节。
        redirect: "manual",
      }),
    );
    const body = parseScanFact(
      await responseJson(response, controller.signal),
      sha256,
      bytes.length,
    );
    if (controller.signal.aborted || !scanCurrent(body) || body.completedAt < started - 5000)
      throw new Error("SCANNER_FACT_INVALID");
    if (body.verdict === "infected") throw new ContentRejected("SCANNER_CONTENT_REJECTED");
    return body;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
