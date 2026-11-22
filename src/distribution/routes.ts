import { exactFields, HttpError, principalRef, readJson, revision } from "../http";
import { uuid } from "../page";
import { requireDeploymentAdmission } from "../publications/admission";
import { ownerPublication, unlistPublication } from "../publications/mutations";
import { isUnscanned } from "../publications/records";
import { type DeploymentEnv, deploymentAdmission } from "../scanner/deployment";
import {
  cachedPublicJson,
  parseEdgeTtl,
  type TrafficCacheEnv,
  withPublicEdgeCache,
} from "../traffic/cache";
import { downloadContent } from "./content";
import { changeGrant, downloadAuthority, readGrant } from "./grants";
import { listPublications, publicCover, publicDetail } from "./queries";
import { issueTicket } from "./tickets";

interface DistributionEnv extends DeploymentEnv, TrafficCacheEnv {
  DB: D1Database;
  QUARANTINE: R2Bucket;
}

function validCoverQuery(url: URL): boolean {
  if (!url.search) return true;
  const keys = [...url.searchParams.keys()];
  const v = url.searchParams.get("v") ?? "";
  return keys.length === 1 && keys[0] === "v" && /^[0-9a-f]{1,64}$/.test(v);
}

export async function catalogRoutes(
  request: Request,
  env: DistributionEnv,
  ctx?: ExecutionContext,
) {
  const url = new URL(request.url);
  if (url.pathname !== "/v1/catalog" && !url.pathname.startsWith("/v1/catalog/")) return null;
  const publicTtl = parseEdgeTtl(env.PUBLIC_EDGE_CACHE_SECONDS, 60);
  if (url.pathname === "/v1/catalog") {
    if (!["GET", "HEAD"].includes(request.method)) return null;
    const release = deploymentAdmission(env);
    return withPublicEdgeCache(
      request,
      publicTtl,
      async (upstream) =>
        cachedPublicJson(
          upstream,
          await listPublications(env.DB, new URL(upstream.url), undefined, release),
        ),
      ctx,
    );
  }
  const parts = url.pathname.split("/");
  if (!uuid.test(parts[3] ?? "")) throw new HttpError(404, "NOT_FOUND");
  const release = deploymentAdmission(env);
  if (parts.length === 5 && parts[4] === "cover" && ["GET", "HEAD"].includes(request.method)) {
    if (!validCoverQuery(url)) throw new HttpError(400, "INVALID_QUERY");
    const coverTtl = parseEdgeTtl(env.COVER_EDGE_CACHE_SECONDS, 3600);
    return withPublicEdgeCache(
      request,
      coverTtl,
      (upstream) =>
        publicCover(
          env.DB,
          env.QUARANTINE,
          parts[3] ?? "",
          upstream.method === "HEAD",
          release,
          upstream,
        ),
      ctx,
    );
  }
  if (parts.length !== 4 || !["GET", "HEAD"].includes(request.method)) return null;
  if (url.search) throw new HttpError(400, "INVALID_QUERY");
  return withPublicEdgeCache(
    request,
    publicTtl,
    async (upstream) =>
      cachedPublicJson(upstream, await publicDetail(env.DB, parts[3] ?? "", release)),
    ctx,
  );
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
