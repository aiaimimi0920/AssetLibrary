import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import { boundedFetch } from "./transport";

interface Env {
  ART_SCANNER: DurableObjectNamespace<ArtScanner>;
}

/** 独立 Worker 的命名 entrypoint 仅供 service binding；默认 HTTP 入口始终 404。 */
export class ScannerService extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    if (request.method !== "POST" || new URL(request.url).pathname !== "/scan")
      return new Response(null, { status: 404 });
    return this.env.ART_SCANNER.getByName("art-singleton").fetch(request);
  }
}

export class ArtScanner extends DurableObject<Env> {
  private busy = false;
  async fetch(request: Request): Promise<Response> {
    if (this.busy) return new Response(null, { status: 503 });
    this.busy = true;
    const container = this.ctx.container;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.signal.addEventListener("abort", abort, { once: true });
    const timeout = setTimeout(abort, 70000);
    try {
      if (!container || request.signal.aborted) throw new Error();
      if (!container.running) container.start({ enableInternet: false });
      await container.setInactivityTimeout(60000);
      const port = container.getTcpPort(8080);
      const until = Date.now() + 10000;
      let ready = false;
      // 只重试 readiness；每次 TCP 请求也有截止，不重复执行扫描。
      while (!ready && Date.now() < until && !controller.signal.aborted) {
        const probe = new AbortController();
        const stop = () => probe.abort();
        controller.signal.addEventListener("abort", stop, { once: true });
        const timer = setTimeout(stop, Math.min(1000, until - Date.now()));
        try {
          const health = await boundedFetch(
            port,
            new Request("http://container/healthz", { signal: probe.signal }),
          );
          ready = health.ok;
          void health.body?.cancel().catch(() => {});
        } catch {
          /* 端口启动或未就绪，不把它当成内容通过。 */
        } finally {
          clearTimeout(timer);
          controller.signal.removeEventListener("abort", stop);
          probe.abort();
        }
        if (!ready) await new Promise((resolve) => setTimeout(resolve, 250));
      }
      if (!ready || controller.signal.aborted) throw new Error();
      return await boundedFetch(port, new Request(request, { signal: controller.signal }));
    } catch {
      controller.abort();
      return new Response(null, { status: 503 });
    } finally {
      clearTimeout(timeout);
      request.signal.removeEventListener("abort", abort);
      if (controller.signal.aborted && container) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          container.destroy().catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(resolve, 3000);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
      this.busy = false;
    }
  }
}

export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
