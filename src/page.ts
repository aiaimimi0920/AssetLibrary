import { HttpError } from "./http";

export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** UUID keyset 游标只控制当前位置，权限始终由每次查询重新判断。 */
export function pageInput(url: URL) {
  const limit = url.searchParams.get("limit") ?? "20";
  const after = url.searchParams.get("after") ?? "";
  if (
    !/^[1-9][0-9]?$/.test(limit) ||
    Number(limit) > 50 ||
    (after && !uuid.test(after)) ||
    [...url.searchParams.keys()].some((key) => !["limit", "after"].includes(key)) ||
    [...url.searchParams.keys()].some((key) => url.searchParams.getAll(key).length !== 1)
  )
    throw new HttpError(400, "INVALID_PAGE");
  return { after, limit: Number(limit) };
}
