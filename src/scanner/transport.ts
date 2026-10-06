/** 绑定取消不被假定为远端已停止；本地有界等待，并负责晚到响应的释放。 */
export async function boundedFetch(
  destination: { fetch(request: Request): Promise<Response> },
  request: Request,
) {
  const signal = request.signal;
  let abort: (() => void) | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("SCANNER_TIMEOUT"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  const pending = Promise.resolve()
    .then(() => {
      if (signal.aborted) throw new Error("SCANNER_TIMEOUT");
      return destination.fetch(request);
    })
    .then((response) => {
      if (signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error("SCANNER_TIMEOUT");
      }
      return response;
    });
  try {
    return await Promise.race([pending, deadline]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}
