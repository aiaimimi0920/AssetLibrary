/** 不整包缓冲；响应取消/请求中止都归还 R2 reader 和 signal listener。 */
export function downloadStream(body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const reader = body.getReader();
  let closed = false;
  let aborted = false;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const release = () => {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  };
  const cancel = async (reason: unknown) => {
    if (closed) return;
    closed = true;
    try {
      await reader.cancel(reason);
    } finally {
      release();
    }
  };
  const abort = () => {
    if (closed) return;
    aborted = true;
    controller.error(new Error("DOWNLOAD_ABORTED"));
    void cancel("DOWNLOAD_ABORTED").catch(() => {});
  };
  return new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    },
    async pull() {
      if (closed) return;
      try {
        const result = await reader.read();
        if (closed || aborted) return;
        if (result.done) {
          closed = true;
          release();
          controller.close();
        } else controller.enqueue(result.value);
      } catch (error) {
        if (!closed) {
          controller.error(error);
          await cancel(error);
        }
      }
    },
    cancel,
  });
}
