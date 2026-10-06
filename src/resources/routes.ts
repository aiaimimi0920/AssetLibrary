import { exactFields, HttpError, json, principalRef, readJson, revision, title } from "../http";
import { type Mutation, mutate } from "./mutations";
import { getResource, listResources } from "./queries";

const resourceId = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export async function resourceRoutes(request: Request, db: D1Database, principal: string) {
  const url = new URL(request.url);
  const method = request.method;
  if (url.pathname === "/v1/me/resources" && method === "GET") {
    const limitText = url.searchParams.get("limit") ?? "20";
    const after = url.searchParams.get("after") ?? "";
    if (
      !/^[1-9][0-9]?$/.test(limitText) ||
      Number(limitText) > 50 ||
      (after && !resourceId.test(after))
    ) {
      throw new HttpError(400, "INVALID_PAGE");
    }
    if ([...url.searchParams.keys()].some((key) => !["limit", "after"].includes(key)))
      throw new HttpError(400, "INVALID_PAGE");
    return json(await listResources(db, principal, after, Number(limitText)));
  }
  let input: Mutation;
  if (url.pathname === "/v1/resources" && method === "POST") {
    const body = await readJson(request);
    exactFields(body, ["kind", "title"]);
    if (body.kind !== "art" && body.kind !== "capability" && body.kind !== "application")
      throw new HttpError(400, "INVALID_KIND");
    input = { action: "create", kind: body.kind, title: title(body.title) };
  } else {
    const parts = url.pathname.split("/");
    const id = parts[3] ?? "";
    if (parts[1] !== "v1" || parts[2] !== "resources" || !resourceId.test(id))
      throw new HttpError(404, "NOT_FOUND");
    if (parts.length === 4 && method === "GET") {
      const resource = await getResource(db, principal, id);
      if (!resource) throw new HttpError(404, "NOT_FOUND");
      return json(resource);
    }
    if (parts.length === 4 && (method === "PATCH" || method === "DELETE")) {
      const body = await readJson(request);
      exactFields(body, method === "PATCH" ? ["title", "revision"] : ["revision"]);
      input =
        method === "PATCH"
          ? { action: "update", id, revision: revision(body.revision), title: title(body.title) }
          : { action: "delete", id, revision: revision(body.revision) };
    } else if (
      parts.length === 6 &&
      parts[4] === "members" &&
      (method === "PUT" || method === "DELETE")
    ) {
      let member: string;
      try {
        member = principalRef(decodeURIComponent(parts[5] ?? ""));
      } catch {
        throw new HttpError(400, "INVALID_PRINCIPAL");
      }
      if (member === principal) throw new HttpError(400, "OWNER_MEMBERSHIP_IMMUTABLE");
      const body = await readJson(request);
      exactFields(body, ["revision"]);
      input = {
        action: method === "PUT" ? "grant" : "revoke",
        id,
        revision: revision(body.revision),
        member,
      };
    } else {
      throw new HttpError(404, "NOT_FOUND");
    }
  }
  return mutate(db, principal, request.headers.get("idempotency-key") ?? "", input);
}
