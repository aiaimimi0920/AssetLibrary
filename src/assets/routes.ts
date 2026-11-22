import { exactFields, HttpError, readJson, revision } from "../http";
import { uuid } from "../page";
import { parseSpace } from "../spaces/catalog";
import { closeAssetRequest, createAssetRequest, respondToAssetRequest } from "./requests-mutations";
import { getPublicAssetRequest, listAssetRequests, listRequestResponses } from "./requests-records";
import {
  parseAssetFormats,
  parseAssetStyle,
  parseBoundedMultiline,
  parseBudgetNote,
  parsePeriodDays,
  parseRequestCategory,
  parseRequestLicense,
  parseRequestTitle,
} from "./taxonomy";

interface AssetRequestEnv {
  DB: D1Database;
}

export async function publicAssetRequestRoutes(request: Request, env: AssetRequestEnv) {
  const url = new URL(request.url);
  if (request.method !== "GET") return null;
  if (url.pathname === "/v1/asset-requests") {
    return listAssetRequests(env.DB, url);
  }
  const parts = url.pathname.split("/");
  if (parts.length === 4 && parts[1] === "v1" && parts[2] === "asset-requests") {
    const id = parts[3] ?? "";
    if (!uuid.test(id)) throw new HttpError(404, "NOT_FOUND");
    if (url.search) throw new HttpError(400, "INVALID_QUERY");
    return getPublicAssetRequest(env.DB, id);
  }
  return null;
}

export async function assetRequestRoutes(
  request: Request,
  env: AssetRequestEnv,
  principal: string,
) {
  const url = new URL(request.url);
  const method = request.method;
  const key = request.headers.get("idempotency-key") ?? "";

  if (url.pathname === "/v1/me/asset-requests" && method === "GET") {
    return listAssetRequests(env.DB, url, principal);
  }
  if (url.pathname === "/v1/asset-requests" && method === "POST") {
    const body = await readJson(request);
    exactFields(body, [
      "title",
      "category",
      "style",
      "space",
      "formats",
      "license",
      "periodDays",
      "budgetNote",
      "description",
      "delivery",
    ]);
    return createAssetRequest(env.DB, principal, key, {
      title: parseRequestTitle(body.title),
      category: parseRequestCategory(body.category),
      style: parseAssetStyle(body.style),
      space: parseSpace(body.space),
      formats: parseAssetFormats(body.formats, true),
      license: parseRequestLicense(body.license),
      periodDays: parsePeriodDays(body.periodDays),
      budgetNote: parseBudgetNote(body.budgetNote),
      description: parseBoundedMultiline(body.description, 1500, "INVALID_REQUEST_DESCRIPTION"),
      delivery: parseBoundedMultiline(body.delivery, 400, "INVALID_REQUEST_DELIVERY"),
    });
  }

  const parts = url.pathname.split("/");
  if (parts[1] !== "v1" || parts[2] !== "asset-requests") return null;
  const id = parts[3] ?? "";
  if (!uuid.test(id)) throw new HttpError(404, "NOT_FOUND");

  if (parts.length === 5 && parts[4] === "close" && method === "POST") {
    const body = await readJson(request);
    exactFields(body, ["revision"]);
    return closeAssetRequest(env.DB, principal, key, id, revision(body.revision));
  }
  if (parts.length === 5 && parts[4] === "responses") {
    if (method === "GET") return listRequestResponses(env.DB, id, principal, url);
    if (method === "POST") {
      const body = await readJson(request);
      exactFields(body, ["message", "publicationId"]);
      let publicationId: string | null = null;
      if (body.publicationId !== null) {
        if (typeof body.publicationId !== "string" || !uuid.test(body.publicationId))
          throw new HttpError(400, "INVALID_PUBLICATION_ID");
        publicationId = body.publicationId;
      }
      return respondToAssetRequest(env.DB, principal, key, id, {
        message: parseBoundedMultiline(body.message, 1000, "INVALID_RESPONSE_MESSAGE"),
        publicationId,
      });
    }
  }
  throw new HttpError(404, "NOT_FOUND");
}
