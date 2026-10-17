import { exactFields, HttpError, principalRef, readJson, revision } from "../http";
import { uuid } from "../page";
import { requireDeploymentAdmission } from "../publications/admission";
import { ownerPublication, unlistPublication } from "../publications/mutations";
import { isUnscanned } from "../publications/records";
import { type DeploymentEnv, deploymentAdmission } from "../scanner/deployment";
import { downloadContent } from "./content";
import { changeGrant, downloadAuthority, readGrant } from "./grants";
import { listPublications, publicDetail } from "./queries";
import { issueTicket } from "./tickets";

interface DistributionEnv extends DeploymentEnv {
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
    const release = deploymentAdmission(env);
    return listPublications(env.DB, url, undefined, release);
  }
  const parts = url.pathname.split("/");
  if (parts.length !== 4 || !uuid.test(parts[3] ?? "")) throw new HttpError(404, "NOT_FOUND");
  const release = deploymentAdmission(env);
  return publicDetail(env.DB, parts[3] ?? "", release);
}

export async function distributionRoutes(request: Request, env: DistributionEnv, actor: string) {
  const url = new URL(request.url);
  if (url.pathname === "/v1/me/library" && request.method === "GET") {
    const release = deploymentAdmission(env);
    return listPublications(env.DB, url, actor, release);
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
    const { row } = await downloadAuthority(env.DB, id, actor);
    const release = isUnscanned(row) ? deploymentAdmission(env) : requireDeploymentAdmission(env);
    return issueTicket(env.DB, id, actor, release);
  }
  if (parts.length === 5 && parts[4] === "content" && ["GET", "HEAD"].includes(request.method)) {
    const { row } = await downloadAuthority(env.DB, id, actor);
    const release = isUnscanned(row) ? deploymentAdmission(env) : requireDeploymentAdmission(env);
    return downloadContent(request, env, id, actor, release);
  }
  throw new HttpError(404, "NOT_FOUND");
}
