import { createHash } from "node:crypto";
import { createResource } from "./fixture.mjs";
import { hostWorker } from "./worker-fixture.mjs";

export const bytes = new TextEncoder().encode("AssetLibrary P2 无害对象\n");
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");

export async function reserve(f, data = bytes, options = {}) {
  const resource = await createResource(f, options);
  const response = await f.request(
    "POST",
    `/v1/resources/${resource.id}/uploads`,
    {
      size: data.length,
      sha256: sha256(data),
    },
    options,
  );
  if (response.status !== 201) throw new Error(`RESERVE_FAILED: ${JSON.stringify(response.body)}`);
  return response.body;
}

export function keyOf(upload) {
  return `quarantine/${upload.resourceId}/${upload.id}`;
}

export async function put(f, upload, data = bytes, options = {}) {
  const token = options.token ?? (await f.token(options.principal));
  const response = await f.mf.dispatchFetch(`http://localhost${upload.contentUrl}`, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/octet-stream",
      "content-length": String(data.length),
      ...options.headers,
    },
    body: data,
  });
  return { status: response.status, body: await response.json() };
}

export async function complete(f, upload) {
  return f.request("POST", `/v1/uploads/${upload.id}/complete`, {});
}
export async function cancel(f, upload) {
  return f.request("DELETE", `/v1/uploads/${upload.id}`);
}
export async function due(f, upload) {
  await f.db.prepare("UPDATE uploads SET reconcile_at = 0 WHERE id = ?").bind(upload.id).run();
}
export async function tick(f) {
  const response = await f.mf.dispatchFetch("http://localhost/cdn-cgi/local/scheduled");
  if (response.status !== 200)
    throw new Error(`CRON_FAILED: ${response.status} ${await response.text()}`);
}

// 故障/竞争测试仅在 Node 宿主装配同一产物，D1/R2 仍使用真实本地 binding。
// 不把故障开关或测试路由编入生产 Worker。
export async function callWithStorage(f, method, url, body, storage) {
  const worker = await hostWorker();
  const response = await worker.fetch(
    new Request(`http://localhost${url}`, {
      method,
      headers: { authorization: `Bearer ${await f.token()}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    { ...f.env, QUARANTINE: storage },
  );
  return { status: response.status, body: await response.json() };
}

export function storageOverride(f, overrides) {
  return new Proxy(f.bucket, {
    get(target, name) {
      if (name in overrides) return overrides[name];
      const value = target[name];
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
