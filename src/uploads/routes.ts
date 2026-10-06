import { exactFields, HttpError, json, readJson } from "../http";
import { uploadContent } from "./content";
import { listUploads } from "./queries";
import { cleanupTerminal, reconcileOne } from "./reconcile";
import { isTerminal, loadOwned, transition, type UploadEnv, uploadView } from "./records";
import { reserveUpload } from "./reserve";

const idPattern = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const reservePath = new RegExp(`^/v1/resources/(${idPattern})/uploads$`);
const uploadPath = new RegExp(`^/v1/uploads/(${idPattern})(?:/(content|complete))?$`);

export async function uploadRoutes(
  request: Request,
  env: UploadEnv,
  principal: string,
): Promise<Response | null> {
  const path = new URL(request.url).pathname;
  const reservation = reservePath.exec(path);
  if (reservation && request.method === "GET")
    return listUploads(env.DB, reservation[1] ?? "", principal, new URL(request.url));
  if (reservation && request.method === "POST")
    return reserveUpload(request, env.DB, reservation[1] ?? "", principal);
  const match = uploadPath.exec(path);
  if (!match) return null;
  let row = await loadOwned(env.DB, match[1] ?? "", principal);
  if (!match[2] && request.method === "GET") return json(uploadView(row));
  if (!match[2] && request.method === "DELETE") {
    // 最多两次 CAS：允许并发 complete 先成功，再由 cancel 关闭隔离对象。
    for (let attempt = 0; attempt < 2 && !isTerminal(row); attempt++)
      row = await transition(env, row, "cancelled", principal);
    if (!isTerminal(row)) throw new HttpError(409, "UPLOAD_STATE_CONFLICT");
    await cleanupTerminal(env, row);
    return json(uploadView(row));
  }
  if (match[2] === "content" && request.method === "PUT")
    return json(await uploadContent(request, env, row));
  if (match[2] === "complete" && request.method === "POST") {
    exactFields(await readJson(request), []);
    row = await reconcileOne(env, row, principal);
    if (row.state === "quarantined") return json(uploadView(row));
    if (row.state === "cancelled" || row.state === "expired")
      throw new HttpError(410, "UPLOAD_CLOSED");
    throw new HttpError(
      409,
      row.state === "pending" ? "UPLOAD_NOT_STORED" : "UPLOAD_OBJECT_INVALID",
    );
  }
  throw new HttpError(404, "NOT_FOUND");
}
