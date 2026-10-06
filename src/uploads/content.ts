import { HttpError } from "../http";
import { cleanupTerminal, objectMatches, reconcileOne } from "./reconcile";
import { isTerminal, loadUpload, objectKey, type UploadEnv, type UploadRow } from "./records";

/** 留住最后一字节直到输入 EOF；防止 R2 在尾部超长/中断被发现前提交合法前缀。 */
function exactInput(size: number): TransformStream<Uint8Array, Uint8Array> {
  let seen = 0;
  let tail: Uint8Array | undefined;
  return new TransformStream({
    transform(chunk, output) {
      if (!chunk.byteLength) return;
      seen += chunk.byteLength;
      if (seen > size) throw new HttpError(400, "UPLOAD_SIZE_MISMATCH");
      if (seen === size) {
        tail = chunk.slice(-1);
        if (chunk.byteLength > 1) output.enqueue(chunk.subarray(0, -1));
      } else output.enqueue(chunk);
    },
    flush(output) {
      if (seen !== size || !tail) throw new HttpError(400, "UPLOAD_SIZE_MISMATCH");
      output.enqueue(tail);
    },
  });
}

/** 原生长度流 + R2 checksum 校验，不做整包 arrayBuffer 或不受背压控制的 tee。 */
async function putOnce(request: Request, env: UploadEnv, row: UploadRow): Promise<R2Object | null> {
  if (!request.body) throw new HttpError(400, "UPLOAD_BODY_REQUIRED");
  const fixed = new FixedLengthStream(row.expected_size);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  const transfer = request.body
    .pipeThrough(exactInput(row.expected_size))
    .pipeTo(fixed.writable, { signal: controller.signal })
    .then(
      () => true,
      () => false,
    );
  try {
    const object = await env.QUARANTINE.put(objectKey(row), fixed.readable, {
      onlyIf: new Headers({ "If-None-Match": "*" }),
      sha256: row.sha256,
      httpMetadata: { contentType: "application/octet-stream", cacheControl: "private, no-store" },
    });
    if (!object) controller.abort();
    const streamed = await transfer;
    if (object && !streamed) throw new HttpError(400, "UPLOAD_STREAM_INCOMPLETE");
    return object;
  } finally {
    clearTimeout(timer);
    controller.abort();
    await transfer;
  }
}

export async function uploadContent(request: Request, env: UploadEnv, row: UploadRow) {
  if (row.resource_state !== "draft") throw new HttpError(404, "NOT_FOUND");
  if (isTerminal(row)) throw new HttpError(410, "UPLOAD_CLOSED");
  if (row.state === "pending" && row.expires_at <= Date.now()) {
    await reconcileOne(env, row, row.owner);
    throw new HttpError(410, "UPLOAD_EXPIRED");
  }
  if (request.headers.get("content-type") !== "application/octet-stream")
    throw new HttpError(415, "BINARY_REQUIRED");
  const length = request.headers.get("content-length");
  if (length === null) throw new HttpError(411, "CONTENT_LENGTH_REQUIRED");
  if (!/^[1-9][0-9]{0,7}$/.test(length) || Number(length) !== row.expected_size)
    throw new HttpError(400, "UPLOAD_SIZE_MISMATCH");
  let object = await env.QUARANTINE.head(objectKey(row));
  if (object) await request.body?.cancel();
  else if (row.state === "quarantined") {
    await reconcileOne(env, row, row.owner);
    throw new HttpError(409, "UPLOAD_OBJECT_MISSING");
  } else {
    object = (await putOnce(request, env, row)) ?? (await env.QUARANTINE.head(objectKey(row)));
  }
  if (!object || !objectMatches(row, object)) {
    await reconcileOne(env, row, row.owner);
    throw new HttpError(409, "UPLOAD_OBJECT_INVALID");
  }
  // PUT 与取消/删除没有分布式事务；再次查询，晚到写入只允许补偿清理。
  const current = await loadUpload(env.DB, row.id);
  if (isTerminal(current)) {
    await cleanupTerminal(env, current);
    throw new HttpError(410, "UPLOAD_CLOSED");
  }
  if (
    current.resource_state !== "draft" ||
    (current.state === "pending" && current.expires_at <= Date.now())
  ) {
    await reconcileOne(env, current, row.owner);
    throw new HttpError(410, "UPLOAD_CLOSED");
  }
  return { id: row.id, state: current.state, objectStored: true };
}
