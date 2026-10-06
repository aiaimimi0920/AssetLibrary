import { observeRequestStops, withResponse } from "./api.client.js";
import { requestDownloadTicket, validatePublication } from "./download.client.js";

const segmentSize = 256 * 1024;

async function readSegment(response, signal, start, end, total, etag) {
  const current = response.headers.get("etag");
  const length = response.headers.get("content-length");
  if (
    response.status !== 206 ||
    response.headers.get("content-type")?.split(";")[0] !== "application/zip" ||
    response.headers.get("content-range") !== `bytes ${start}-${end}/${total}` ||
    !/^"[\x21\x23-\x7e]{1,126}"$/.test(current ?? "") ||
    (etag !== null && current !== etag) ||
    (length !== null && length !== String(end - start + 1)) ||
    !response.body
  )
    throw new Error("DOWNLOAD_RANGE_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const bytes = new Uint8Array(end - start + 1);
  let offset = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      if (offset + value.byteLength > bytes.length) throw new Error("DOWNLOAD_SIZE_EXCEEDED");
      bytes.set(value, offset);
      offset += value.byteLength;
    }
    if (offset !== bytes.length) throw new Error("DOWNLOAD_TRUNCATED");
    return { bytes, etag: current };
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

/** 一页只保留一个有界包体；只提交完整段，清除后的迟到响应不得复活旧状态。 */
export function createDownloadTransfer(changed = () => {}) {
  let state = null;
  let attempt = null;
  let epoch = 0;
  const snapshot = () =>
    state
      ? {
          publication: { ...state.publication },
          offset: state.offset,
          total: state.publication.size,
          resumable: !attempt && state.offset > 0,
        }
      : null;
  const notify = () => changed(snapshot());
  function clear() {
    epoch += 1;
    state = null;
    attempt?.abort();
    notify();
  }
  const unsubscribe = observeRequestStops(clear);
  async function fetch(publication, signal, resume = false) {
    if (attempt) throw new Error("DOWNLOAD_ALREADY_RUNNING");
    if (resume) {
      if (!state || state.offset === 0) throw new Error("NO_RESUMABLE_DOWNLOAD");
    } else {
      clear();
      validatePublication(publication);
      state = {
        publication: { ...publication },
        bytes: new Uint8Array(publication.size),
        offset: 0,
        etag: null,
        attempts: 0,
      };
    }
    const active = state;
    const current = epoch;
    const controller = new AbortController();
    attempt = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(abort, 120000);
    const check = () => {
      controller.signal.throwIfAborted();
      if (current !== epoch || state !== active) throw new DOMException("Aborted", "AbortError");
    };
    notify();
    try {
      check();
      active.attempts += 1;
      const ticket = await requestDownloadTicket(active.publication, controller.signal);
      check();
      while (active.offset < active.publication.size) {
        const start = active.offset;
        const end = Math.min(start + segmentSize, active.publication.size) - 1;
        const segment = await withResponse(
          ticket.path,
          {
            ticket: ticket.ticket,
            signal: controller.signal,
            range: `bytes=${start}-${end}`,
            ...(active.etag === null ? {} : { ifRange: active.etag }),
          },
          (response, controlled) =>
            readSegment(response, controlled, start, end, active.publication.size, active.etag),
        );
        check();
        active.bytes.set(segment.bytes, start);
        active.etag = segment.etag;
        active.offset = end + 1;
        notify();
      }
      const digest = await crypto.subtle.digest("SHA-256", active.bytes);
      check();
      const actual = [...new Uint8Array(digest)]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      if (actual !== active.publication.sha256) throw new Error("DOWNLOAD_DIGEST_MISMATCH");
      const result = {
        blob: new Blob([active.bytes], { type: "application/zip" }),
        versionId: active.publication.versionId,
      };
      state = null;
      return result;
    } catch (error) {
      // 仅传输故障允许用户手动继续；取消、权限或协议失败一律丢弃。
      const transport =
        error instanceof TypeError || error.message === "DOWNLOAD_TRUNCATED" || error.status >= 500;
      if (
        current === epoch &&
        (!transport || controller.signal.aborted || active.offset === 0 || active.attempts >= 3)
      )
        clear();
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (attempt === controller) attempt = null;
      notify();
    }
  }
  return {
    fetch,
    snapshot,
    clear,
    dispose: () => {
      clear();
      unsubscribe();
    },
  };
}
