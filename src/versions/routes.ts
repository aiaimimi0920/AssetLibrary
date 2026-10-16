import { exactFields, HttpError, json, readJson, revision } from "../http";
import { requirePublishAdmission } from "../publications/admission";
import { publishVersion } from "../publications/mutations";
import { type DeploymentEnv, deploymentAdmission } from "../scanner/deployment";
import { createVersion } from "./create";
import { decideVersion } from "./decisions";
import { mayReadReview, type ReviewConfig, reviewers } from "./policy";
import { listReviews, listVersions } from "./queries";
import { loadVersion, versionView } from "./records";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
interface VersionEnv extends ReviewConfig, DeploymentEnv {
  DB: D1Database;
}

export async function versionRoutes(request: Request, env: VersionEnv, principal: string) {
  const parts = new URL(request.url).pathname.split("/");
  const method = request.method;
  const release = deploymentAdmission(env);
  if (parts[1] !== "v1") return null;
  if (parts[2] === "reviews") {
    if (parts.length !== 3 || method !== "GET") throw new HttpError(404, "NOT_FOUND");
    return listReviews(env.DB, env, principal, new URL(request.url), release);
  }
  if (
    parts[2] === "resources" &&
    parts.length === 5 &&
    parts[4] === "versions" &&
    ["GET", "POST"].includes(method)
  ) {
    if (!uuid.test(parts[3] ?? "")) throw new HttpError(404, "NOT_FOUND");
    if (method === "GET")
      return listVersions(env.DB, parts[3] ?? "", principal, new URL(request.url), release);
    const body = await readJson(request);
    exactFields(body, ["label", "uploadId", "resourceRevision"]);
    if (typeof body.label !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(body.label))
      throw new HttpError(400, "INVALID_VERSION_LABEL");
    if (typeof body.uploadId !== "string" || !uuid.test(body.uploadId))
      throw new HttpError(400, "INVALID_UPLOAD_ID");
    return createVersion(
      env.DB,
      principal,
      {
        resourceId: parts[3] ?? "",
        label: body.label,
        uploadId: body.uploadId,
        resourceRevision: revision(body.resourceRevision),
      },
      release,
    );
  }
  if (parts[2] !== "versions") return null;
  const id = parts[3] ?? "";
  if (!uuid.test(id)) throw new HttpError(404, "NOT_FOUND");
  const action = parts[4];
  const reading = parts.length === 4 && method === "GET";
  const writing =
    parts.length === 5 &&
    method === "POST" &&
    ["review", "withdraw", "publish"].includes(action ?? "");
  if (!reading && !writing) throw new HttpError(404, "NOT_FOUND");
  if (action === "review" && !reviewers(env).includes(principal))
    throw new HttpError(404, "NOT_FOUND");
  const row = await loadVersion(env.DB, id);
  if (reading) {
    if (row.owner !== principal && !mayReadReview(env, principal))
      throw new HttpError(404, "NOT_FOUND");
    return json(versionView(row, release));
  }
  if (action === "review") {
    if (row.owner === principal) throw new HttpError(409, "SELF_REVIEW_FORBIDDEN");
  } else if (row.owner !== principal) throw new HttpError(404, "NOT_FOUND");
  const body = await readJson(request);
  exactFields(body, action === "review" ? ["revision", "decision", "reason"] : ["revision"]);
  const expected = revision(body.revision);
  if (action === "review") {
    if (body.decision !== "approved" && body.decision !== "rejected")
      throw new HttpError(400, "INVALID_REVIEW_DECISION");
    if (
      typeof body.reason !== "string" ||
      body.reason.length > 500 ||
      !body.reason.trim() ||
      /\p{Cc}/u.test(body.reason)
    )
      throw new HttpError(400, "INVALID_REVIEW_REASON");
    return decideVersion(
      env.DB,
      id,
      principal,
      expected,
      body.decision,
      body.reason.trim(),
      release,
    );
  }
  if (action === "withdraw")
    return decideVersion(env.DB, id, principal, expected, "withdrawn", null, release);
  if (row.revision !== expected) throw new HttpError(409, "REVISION_CONFLICT");
  if (row.state !== "approved") throw new HttpError(409, "VERSION_NOT_APPROVED");
  if (row.binding_current !== 1) throw new HttpError(409, "VERSION_BINDING_CHANGED");
  const admitted = requirePublishAdmission(row, env);
  return publishVersion(env.DB, id, principal, expected, admitted);
}
