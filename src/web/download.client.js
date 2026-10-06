import { api, withResponse } from "./api.client.js";

const maxSize = 8 * 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 仅浏览器在包体上限内汇集字节以做 WebCrypto 摘要；Worker 仍流式返回。 */
export async function readPackage(response, signal, publication, progress = () => {}) {
  // workerd 的未知长度响应可使用 chunked；有声明时严格核对，无声明时仍逐块计数及验摘要。
  const length = response.headers.get("content-length");
  if (
    response.status !== 200 ||
    response.headers.get("content-type")?.split(";")[0] !== "application/zip" ||
    (length !== null && (!/^[1-9][0-9]*$/.test(length) || Number(length) !== publication.size)) ||
    !response.body
  )
    throw new Error("DOWNLOAD_RESPONSE_INVALID");
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  const abort = () => {
    void reader.cancel("DOWNLOAD_ABORTED").catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const { value, done } = await reader.read();
      signal.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > publication.size || size > maxSize) throw new Error("DOWNLOAD_SIZE_EXCEEDED");
      chunks.push(value);
      progress(size, publication.size);
    }
    if (size !== publication.size) throw new Error("DOWNLOAD_TRUNCATED");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.length;
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    signal.throwIfAborted();
    const actual = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    if (actual !== publication.sha256) throw new Error("DOWNLOAD_DIGEST_MISMATCH");
    return new Blob([bytes], { type: "application/zip" });
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function fetchPackage(publication, signal, progress) {
  if (
    !uuid.test(publication.id) ||
    !uuid.test(publication.versionId) ||
    !Number.isSafeInteger(publication.size) ||
    publication.size < 1 ||
    publication.size > maxSize ||
    !/^[0-9a-f]{64}$/.test(publication.sha256)
  )
    throw new Error("INVALID_DOWNLOAD_METADATA");
  const ticket = await api(`/v1/publications/${publication.id}/tickets`, {
    method: "POST",
    body: {},
    signal,
  });
  const path = `/v1/publications/${publication.id}/content`;
  if (
    ticket.publicationId !== publication.id ||
    ticket.contentPath !== path ||
    !/^[0-9a-f]{64}$/.test(ticket.ticket)
  )
    throw new Error("DOWNLOAD_TICKET_INVALID");
  return withResponse(path, { ticket: ticket.ticket, signal }, (response, controlled) =>
    readPackage(response, controlled, publication, progress),
  );
}

export function savePackage(blob, versionId) {
  if (!uuid.test(versionId)) throw new Error("INVALID_DOWNLOAD_METADATA");
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  try {
    link.href = url;
    link.download = `package-${versionId}.zip`;
    document.body.append(link);
    link.click();
  } finally {
    link.remove();
    // 保留浏览器启动下载所需的短暂窗口，不把对象 URL 或票据持久化。
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
