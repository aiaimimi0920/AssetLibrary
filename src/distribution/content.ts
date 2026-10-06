import { HttpError } from "../http";
import { objectMatches } from "../uploads/reconcile";
import { objectKey } from "../uploads/records";
import { downloadRange } from "./range";
import { downloadStream } from "./stream";
import { authorizeTicket } from "./tickets";

interface DistributionEnv {
  DB: D1Database;
  QUARANTINE: R2Bucket;
}

/** 每次 GET/HEAD/续传重查 primary；R2 等待期间发生撤销时取消取得的对象流。 */
export async function downloadContent(
  request: Request,
  env: DistributionEnv,
  id: string,
  actor: string,
) {
  const token = request.headers.get("x-download-ticket") ?? "";
  const row = await authorizeTicket(env.DB, id, actor, token);
  if (request.signal.aborted) throw new HttpError(499, "DOWNLOAD_ABORTED");
  let range: ReturnType<typeof downloadRange>;
  try {
    range = downloadRange(request, row.expected_size, row.etag);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 416) throw error;
    return new Response(null, {
      status: 416,
      headers: {
        "Content-Range": `bytes */${row.expected_size}`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }
  const key = objectKey({ resource_id: row.resource_id, id: row.upload_id });
  const object =
    request.method === "HEAD"
      ? await env.QUARANTINE.head(key)
      : await env.QUARANTINE.get(key, {
          onlyIf: { etagMatches: row.etag },
          ...(range ? { range } : {}),
        });
  const body =
    object && "body" in object
      ? ((object as R2ObjectBody).body as ReadableStream<Uint8Array>)
      : null;
  try {
    if (!object || !objectMatches(row, object) || (request.method !== "HEAD" && !body))
      throw new HttpError(409, "DISTRIBUTION_OBJECT_CHANGED");
    const current = await authorizeTicket(env.DB, id, actor, token);
    if (current.revision !== row.revision || current.etag !== row.etag)
      throw new HttpError(404, "NOT_FOUND");
    if (request.signal.aborted) throw new HttpError(499, "DOWNLOAD_ABORTED");
  } catch (error) {
    if (body) await body.cancel().catch(() => {});
    throw error;
  }
  const headers = new Headers({
    "Content-Type": "application/zip",
    "Content-Disposition": `attachment; filename="art-${row.version_id}.zip"`,
    "Content-Length": String(range?.length ?? row.expected_size),
    "Cache-Control": "private, no-store",
    "Accept-Ranges": "bytes",
    "X-Content-Type-Options": "nosniff",
    ETag: `"${row.etag}"`,
  });
  if (range)
    headers.set(
      "Content-Range",
      `bytes ${range.offset}-${range.offset + range.length - 1}/${row.expected_size}`,
    );
  return new Response(body ? downloadStream(body, request.signal) : null, {
    status: range ? 206 : 200,
    headers,
  });
}
