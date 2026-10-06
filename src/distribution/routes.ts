import { exactFields, HttpError, json, principalRef, readJson, revision } from "../http";
import { uuid } from "../page";
import { requireDeploymentAdmission } from "../publications/admission";
import { ownerPublication, unlistPublication } from "../publications/mutations";
import { downloadContent } from "./content";
import { changeGrant, downloadAuthority, readGrant } from "./grants";
import { listPublications, publicDetail } from "./queries";
import { issueTicket } from "./tickets";

interface DistributionEnv {
  DB: D1Database;
  QUARANTINE: R2Bucket;
}

export async function catalogRoutes(request: Request, env: DistributionEnv) {
  const url = new URL(request.url);
  if (
    (url.pathname !== "/v1/catalog" && !url.pathname.startsWith("/v1/catalog/")) ||
    request.method !== "GET"
  )
    return null;
  if (url.pathname === "/v1/catalog") {
    // 门禁未完成时不暴露 seeded 历史记录，也不把不可用伪装成可用空目录。
    try {
      requireDeploymentAdmission();
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.code }, 503);
      throw error;
    }
    return listPublications(env.DB, url);
  }
  const parts = url.pathname.split("/");
  if (parts.length !== 4 || !uuid.test(parts[3] ?? "")) throw new HttpError(404, "NOT_FOUND");
  requireDeploymentAdmission();
  return publicDetail(env.DB, parts[3] ?? "");
}

export async function distributionRoutes(request: Request, env: DistributionEnv, actor: string) {
  const url = new URL(request.url);
  if (url.pathname === "/v1/me/library" && request.method === "GET") {
    requireDeploymentAdmission();
    return listPublications(env.DB, url, actor);
  }
  const parts = url.pathname.split("/");
  if (parts[1] !== "v1" || parts[2] !== "publications") return null;
  const id = parts[3] ?? "";
  if (!uuid.test(id)) throw new HttpError(404, "NOT_FOUND");
  if (parts.length === 4 && request.method === "GET") return ownerPublication(env.DB, id, actor);
  if (parts.length === 5 && parts[4] === "unlist" && request.method === "POST") {
    const body = await readJson(request);
    exactFields(body, ["revision"]);
    return unlistPublication(env.DB, id, actor, revision(body.revision));
  }
  if (
    parts.length === 6 &&
    parts[4] === "grants" &&
    ["GET", "PUT", "DELETE"].includes(request.method)
  ) {
    let principal: string;
    try {
      principal = principalRef(decodeURIComponent(parts[5] ?? ""));
    } catch {
      throw new HttpError(400, "INVALID_PRINCIPAL");
    }
    if (request.method === "GET") return readGrant(env.DB, id, actor, principal);
    const body = await readJson(request);
    exactFields(body, ["revision"]);
    const expected = body.revision === 0 && request.method === "PUT" ? 0 : revision(body.revision);
    return changeGrant(
      env.DB,
      id,
      actor,
      principal,
      expected,
      request.method === "PUT" ? "active" : "revoked",
    );
  }
  if (parts.length === 5 && parts[4] === "tickets" && request.method === "POST") {
    const body = await readJson(request);
    exactFields(body, []);
    await downloadAuthority(env.DB, id, actor);
    requireDeploymentAdmission();
    return issueTicket(env.DB, id, actor);
  }
  if (parts.length === 5 && parts[4] === "content" && ["GET", "HEAD"].includes(request.method)) {
    await downloadAuthority(env.DB, id, actor);
    requireDeploymentAdmission();
    return downloadContent(request, env, id, actor);
  }
  throw new HttpError(404, "NOT_FOUND");
}
