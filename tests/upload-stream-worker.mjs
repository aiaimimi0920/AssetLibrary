import worker from "./index.js";

// 仅由本地 fixture 装配：绕过宿主 HTTP 长度检查，仍调用原始 Worker 与原生长度流。
export default {
  scheduled: worker.scheduled,
  async fetch(request, env, context) {
    if (request.headers.get("x-test-inspection-fault") === "interrupt") {
      const bucket = new Proxy(env.QUARANTINE, {
        get(target, name) {
          if (name !== "get")
            return typeof target[name] === "function" ? target[name].bind(target) : target[name];
          return async (...args) => {
            const object = await target.get(...args);
            if (!object?.body) return object;
            const reader = object.body.getReader();
            let sent = false;
            const body = new ReadableStream({
              async pull(controller) {
                if (sent) {
                  await reader.cancel();
                  reader.releaseLock();
                  return controller.error(new Error("TEST_ONLY_R2_INTERRUPT"));
                }
                sent = true;
                const { value, done } = await reader.read();
                if (done) return controller.close();
                controller.enqueue(value.subarray(0, 512));
              },
              async cancel() {
                await reader.cancel();
                reader.releaseLock();
              },
            });
            return new Proxy(object, {
              get: (target, name) => (name === "body" ? body : target[name]),
            });
          };
        },
      });
      await worker.scheduled({}, { ...env, QUARANTINE: bucket });
      return new Response("ok");
    }
    const mode = request.headers.get("x-test-stream-fault");
    if (!mode || request.method !== "PUT") return worker.fetch(request, env, context);
    const reader = request.body.getReader();
    let first = true;
    const body = new ReadableStream({
      async pull(controller) {
        const chunk = await reader.read();
        if (chunk.done) {
          if (mode === "late-interrupt") controller.error(new Error("TEST_ONLY_LATE_INTERRUPT"));
          else {
            if (mode === "long") controller.enqueue(Uint8Array.of(0));
            controller.close();
          }
          reader.releaseLock();
        } else if (mode === "interrupt") {
          controller.error(new Error("TEST_ONLY_STREAM_INTERRUPTED"));
          await reader.cancel();
          reader.releaseLock();
        } else {
          controller.enqueue(mode === "short" && first ? chunk.value.subarray(1) : chunk.value);
          first = false;
        }
      },
      async cancel(reason) {
        await reader.cancel(reason);
        reader.releaseLock();
      },
    });
    return worker.fetch(new Request(request, { body }), env, context);
  },
};
